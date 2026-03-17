const EVENTS = require('./events')
const { clearVoteTimers, handleError, handleSuccess } = require('./helpers')

function registerGameHandlers(
  io,
  socket,
  roomManager,
  getRoomChannel,
  voteTimerStore
) {
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
    clearVoteTimers(voteTimerStore, roomId)

    const reminderTimer = setTimeout(() => {
      try {
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

      } catch (error) {
        console.error('[vote-timer:reminder] failed', {
          roomId,
          error,
        })
      }
    }, roomManager.voteReminderMs)

    const timeoutTimer = setTimeout(() => {
      try {
        const resolution = roomManager.completeVoteTimeout(roomId)
        if (resolution) {
          emitVoteResult(roomId, resolution)
        } else {
          console.warn('[vote-timer:timeout] completed without resolution', {
            roomId,
          })
        }
      } catch (error) {
        console.error('[vote-timer:timeout] failed', {
          roomId,
          error,
        })
      } finally {
        clearVoteTimers(voteTimerStore, roomId)
      }
    }, roomManager.voteTimeoutMs)

    voteTimerStore.set(roomId, {
      reminderTimer,
      timeoutTimer,
    })
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

      if (result.allConfirmed && result.speakingState) {
        io.to(roomChannel).emit(EVENTS.server.GAME_SPEAKING_STARTED, result.speakingState)
      }

      handleSuccess(ack, {
        room: result.roomState,
        speakingState: result.speakingState,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.GAME_CONFIRM_WORD, ack, error)
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
      handleError(socket, EVENTS.client.GAME_START_VOTE, ack, error)
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
        clearVoteTimers(voteTimerStore, result.room.id)
        const resolution = roomManager.finalizeVoting(result.room.id)
        emitVoteResult(result.room.id, resolution)
      } else {
        emitRoomState(result.room.id)
      }

      handleSuccess(ack, {
        room: result.roomState,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.GAME_VOTE, ack, error)
    }
  })

  socket.on(EVENTS.client.GAME_CONTINUE, (payload = {}, ack) => {
    try {
      const result = roomManager.continueGame(socket.data.playerId)
      clearVoteTimers(voteTimerStore, result.room.id)

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
      handleError(socket, EVENTS.client.GAME_CONTINUE, ack, error)
    }
  })

  socket.on(EVENTS.client.GAME_RESTART, (payload = {}, ack) => {
    try {
      const result = roomManager.restartGame(socket.data.playerId)
      clearVoteTimers(voteTimerStore, result.room.id)

      io.to(getRoomChannel(result.room.id)).emit(EVENTS.server.GAME_RESTARTED, {
        room: result.roomState,
      })

      handleSuccess(ack, {
        room: result.roomState,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.GAME_RESTART, ack, error)
    }
  })
}

module.exports = registerGameHandlers
