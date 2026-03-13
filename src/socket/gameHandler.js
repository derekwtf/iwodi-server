const EVENTS = require('./events')

function registerGameHandlers(
  io,
  socket,
  roomManager,
  getRoomChannel,
  voteTimerStore
) {
  const clearVoteTimers = (roomId) => {
    const timers = voteTimerStore.get(roomId)
    if (!timers) {
      return
    }

    if (timers.reminderTimer) {
      clearTimeout(timers.reminderTimer)
    }
    if (timers.timeoutTimer) {
      clearTimeout(timers.timeoutTimer)
    }

    voteTimerStore.delete(roomId)
  }

  const emitRoomState = (roomId) => {
    io.to(getRoomChannel(roomId)).emit(EVENTS.server.ROOM_STATE, {
      room: roomManager.getRoomState(roomId),
    })
  }

  const emitVoteResult = (roomId, resolution) => {
    io.to(getRoomChannel(roomId)).emit(EVENTS.server.GAME_RESULT, resolution.publicState)
    emitRoomState(roomId)
  }

  const scheduleVoteTimers = (roomId) => {
    clearVoteTimers(roomId)

    const reminderTimer = setTimeout(() => {
      const pendingPlayers = roomManager.getPendingVoters(roomId)
      pendingPlayers.forEach((playerId) => {
        const targetSocketId = roomManager.getActiveSocketId(playerId)
        if (!targetSocketId) {
          return
        }

        io.to(targetSocketId).emit(EVENTS.server.GAME_VOTE_REMINDER, {
          roomId,
          pendingPlayerIds: pendingPlayers,
        })
      })
    }, roomManager.voteReminderMs)

    const timeoutTimer = setTimeout(() => {
      const resolution = roomManager.completeVoteTimeout(roomId)
      if (resolution) {
        emitVoteResult(roomId, resolution)
      }
      clearVoteTimers(roomId)
    }, roomManager.voteTimeoutMs)

    voteTimerStore.set(roomId, {
      reminderTimer,
      timeoutTimer,
    })
  }

  const handleError = (action, ack, error) => {
    const payload = {
      action,
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.message || '服务异常，请稍后重试',
      },
    }

    socket.emit(EVENTS.server.REQUEST_ERROR, payload)
    if (typeof ack === 'function') {
      ack({
        ok: false,
        ...payload,
      })
    }
  }

  const handleSuccess = (ack, payload) => {
    if (typeof ack === 'function') {
      ack({
        ok: true,
        ...payload,
      })
    }
  }

  socket.on(EVENTS.client.GAME_CONFIRM_WORD, (payload = {}, ack) => {
    try {
      const result = roomManager.confirmWord(socket.data.playerId)
      const roomChannel = getRoomChannel(result.room.id)

      io.to(roomChannel).emit(EVENTS.server.GAME_PLAYER_CONFIRMED, {
        roomId: result.room.id,
        playerId: socket.data.playerId,
        confirmedPlayers: result.confirmedPlayers,
        confirmedCount: result.confirmedCount,
        totalPlayers: result.totalPlayers,
      })
      emitRoomState(result.room.id)

      if (result.allConfirmed && result.speakingState) {
        io.to(roomChannel).emit(EVENTS.server.GAME_SPEAKING_STARTED, result.speakingState)
      }

      handleSuccess(ack, {
        room: result.roomState,
        speakingState: result.speakingState,
      })
    } catch (error) {
      handleError(EVENTS.client.GAME_CONFIRM_WORD, ack, error)
    }
  })

  socket.on(EVENTS.client.GAME_START_VOTE, (payload = {}, ack) => {
    try {
      const result = roomManager.startVote(socket.data.playerId)
      scheduleVoteTimers(result.room.id)

      io.to(getRoomChannel(result.room.id)).emit(EVENTS.server.GAME_VOTE_STARTED, {
        ...result.publicState,
        voteReminderMs: roomManager.voteReminderMs,
        voteTimeoutMs: roomManager.voteTimeoutMs,
      })
      emitRoomState(result.room.id)

      handleSuccess(ack, {
        room: result.roomState,
        game: result.publicState,
      })
    } catch (error) {
      handleError(EVENTS.client.GAME_START_VOTE, ack, error)
    }
  })

  socket.on(EVENTS.client.GAME_VOTE, (payload = {}, ack) => {
    try {
      const result = roomManager.submitVote(socket.data.playerId, payload.targetId)
      const roomChannel = getRoomChannel(result.room.id)

      io.to(roomChannel).emit(EVENTS.server.GAME_PLAYER_VOTED, {
        roomId: result.room.id,
        playerId: socket.data.playerId,
        votedPlayers: result.votedPlayers,
        totalPlayers: result.totalPlayers,
      })

      if (result.allVoted) {
        clearVoteTimers(result.room.id)
        const resolution = roomManager.finalizeVoting(result.room.id)
        emitVoteResult(result.room.id, resolution)
      } else {
        emitRoomState(result.room.id)
      }

      handleSuccess(ack, {
        room: result.roomState,
      })
    } catch (error) {
      handleError(EVENTS.client.GAME_VOTE, ack, error)
    }
  })

  socket.on(EVENTS.client.GAME_CONTINUE, (payload = {}, ack) => {
    try {
      const result = roomManager.continueGame(socket.data.playerId)
      clearVoteTimers(result.room.id)

      if (result.type === 'nextRound') {
        io.to(getRoomChannel(result.room.id)).emit(
          EVENTS.server.GAME_NEXT_ROUND,
          result.publicState
        )
      } else {
        io.to(getRoomChannel(result.room.id)).emit(
          EVENTS.server.GAME_ENDED,
          result.endedPayload
        )
      }

      emitRoomState(result.room.id)
      handleSuccess(ack, {
        room: result.roomState,
      })
    } catch (error) {
      handleError(EVENTS.client.GAME_CONTINUE, ack, error)
    }
  })

  socket.on(EVENTS.client.GAME_RESTART, (payload = {}, ack) => {
    try {
      const result = roomManager.restartGame(socket.data.playerId)
      clearVoteTimers(result.room.id)

      io.to(getRoomChannel(result.room.id)).emit(EVENTS.server.GAME_RESTARTED, {
        room: result.roomState,
      })
      emitRoomState(result.room.id)

      handleSuccess(ack, {
        room: result.roomState,
      })
    } catch (error) {
      handleError(EVENTS.client.GAME_RESTART, ack, error)
    }
  })
}

module.exports = registerGameHandlers
