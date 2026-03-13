const EVENTS = require('./events')

function registerRoomHandlers(io, socket, roomManager, getRoomChannel) {
  const emitGameAction = (roomId, gameAction) => {
    if (!roomId || !gameAction || !gameAction.payload) {
      return
    }

    const roomChannel = getRoomChannel(roomId)
    switch (gameAction.type) {
      case 'speakingStarted':
        io.to(roomChannel).emit(EVENTS.server.GAME_SPEAKING_STARTED, gameAction.payload)
        break
      case 'result':
        io.to(roomChannel).emit(EVENTS.server.GAME_RESULT, gameAction.payload)
        break
      case 'ended':
        io.to(roomChannel).emit(EVENTS.server.GAME_ENDED, gameAction.payload)
        break
      case 'stateSync':
      default:
        io.to(roomChannel).emit(EVENTS.server.GAME_STATE_SYNC, gameAction.payload)
        break
    }
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

  socket.on(EVENTS.client.ROOM_CREATE, (payload = {}, ack) => {
    try {
      const result = roomManager.createRoom({
        playerId: socket.data.playerId,
        nickname: payload.nickname,
        avatar: payload.avatar,
      })

      const roomChannel = getRoomChannel(result.room.id)
      const roomState = roomManager.getRoomState(result.room.id)
      socket.join(roomChannel)
      socket.emit(EVENTS.server.ROOM_CREATED, { room: roomState })
      socket.emit(EVENTS.server.ROOM_STATE, { room: roomState })

      handleSuccess(ack, { room: roomState })
    } catch (error) {
      handleError(EVENTS.client.ROOM_CREATE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_JOIN, (payload = {}, ack) => {
    try {
      const roomId = String(payload.roomId || '')
      const result = roomManager.joinRoom(roomId, {
        playerId: socket.data.playerId,
        nickname: payload.nickname,
        avatar: payload.avatar,
      })

      if (result.previousRoomResult) {
        const previousRoomId = result.previousRoomResult.roomId
        const previousRoomChannel = getRoomChannel(previousRoomId)
        socket.leave(previousRoomChannel)

        if (result.previousRoomResult.roomState) {
          io.to(previousRoomChannel).emit(EVENTS.server.ROOM_PLAYER_LEFT, {
            player: result.previousRoomResult.removedPlayer,
            room: result.previousRoomResult.roomState,
            reason: result.previousRoomResult.reason,
          })
          io.to(previousRoomChannel).emit(EVENTS.server.ROOM_STATE, {
            room: result.previousRoomResult.roomState,
          })

          if (result.previousRoomResult.hostChanged) {
            io.to(previousRoomChannel).emit(EVENTS.server.ROOM_HOST_CHANGED, {
              player: result.previousRoomResult.hostChanged,
              room: result.previousRoomResult.roomState,
            })
          }
        }

        emitGameAction(previousRoomId, result.previousRoomResult.gameAction)
      }

      const roomChannel = getRoomChannel(result.room.id)
      const roomState = roomManager.getRoomState(result.room.id)
      socket.join(roomChannel)

      socket.emit(EVENTS.server.ROOM_JOINED, { room: roomState })
      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, { room: roomState })

      if (!result.alreadyInRoom) {
        socket.to(roomChannel).emit(EVENTS.server.ROOM_PLAYER_JOINED, {
          player: result.player,
          room: roomState,
        })
      }

      handleSuccess(ack, { room: roomState })
    } catch (error) {
      handleError(EVENTS.client.ROOM_JOIN, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_LEAVE, (payload = {}, ack) => {
    try {
      const roomId = roomManager.getRoomIdForPlayer(socket.data.playerId)
      if (!roomId) {
        handleSuccess(ack, { roomId: null })
        return
      }

      const result = roomManager.leaveRoom(roomId, socket.data.playerId, {
        reason: 'leave',
      })
      socket.leave(getRoomChannel(roomId))
      socket.emit(EVENTS.server.ROOM_LEFT, { roomId })

      if (result && result.roomState) {
        const roomChannel = getRoomChannel(roomId)
        io.to(roomChannel).emit(EVENTS.server.ROOM_PLAYER_LEFT, {
          player: result.removedPlayer,
          room: result.roomState,
        })
        io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
          room: result.roomState,
        })

        if (result.hostChanged) {
          io.to(roomChannel).emit(EVENTS.server.ROOM_HOST_CHANGED, {
            player: result.hostChanged,
            room: result.roomState,
          })
        }
      }

      emitGameAction(roomId, result && result.gameAction)

      handleSuccess(ack, {
        roomId,
        room: result ? result.roomState : null,
      })
    } catch (error) {
      handleError(EVENTS.client.ROOM_LEAVE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_HEARTBEAT, (payload = {}, ack) => {
    try {
      const result = roomManager.heartbeat(socket.data.playerId)
      handleSuccess(ack, {
        roomId: result.room.id,
        status: result.status,
      })
    } catch (error) {
      handleError(EVENTS.client.ROOM_HEARTBEAT, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_KEEP_ALIVE, (payload = {}, ack) => {
    try {
      const result = roomManager.keepAlive(socket.data.playerId)
      const roomChannel = getRoomChannel(result.room.id)

      io.to(roomChannel).emit(EVENTS.server.ROOM_IDLE_RESUMED, {
        roomId: result.room.id,
        status: result.status,
      })

      handleSuccess(ack, {
        roomId: result.room.id,
        status: result.status,
      })
    } catch (error) {
      handleError(EVENTS.client.ROOM_KEEP_ALIVE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_SET_SPY_COUNT, (payload = {}, ack) => {
    try {
      const result = roomManager.setSpyCount(
        socket.data.playerId,
        payload.spyCount
      )
      const roomChannel = getRoomChannel(result.room.id)

      io.to(roomChannel).emit(EVENTS.server.ROOM_SPY_COUNT_CHANGED, {
        spyCount: result.spyCount,
        room: result.roomState,
      })
      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
        room: result.roomState,
      })

      handleSuccess(ack, {
        room: result.roomState,
        spyCount: result.spyCount,
      })
    } catch (error) {
      handleError(EVENTS.client.ROOM_SET_SPY_COUNT, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_UPDATE_PROFILE, (payload = {}, ack) => {
    try {
      const result = roomManager.updatePlayerProfile(socket.data.playerId, {
        nickname: payload.nickname,
        avatar: payload.avatar,
      })
      const roomChannel = getRoomChannel(result.room.id)

      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
        room: result.roomState,
      })

      if (result.gameState) {
        io.to(roomChannel).emit(EVENTS.server.GAME_STATE_SYNC, result.gameState)
      }

      handleSuccess(ack, {
        room: result.roomState,
        gameState: result.gameState,
        player: result.player,
      })
    } catch (error) {
      handleError(EVENTS.client.ROOM_UPDATE_PROFILE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_KICK_PLAYER, (payload = {}, ack) => {
    try {
      const targetPlayerId = String(payload.playerId || '')
      const targetSocketId = roomManager.getActiveSocketId(targetPlayerId)
      const result = roomManager.kickPlayer(socket.data.playerId, targetPlayerId)
      const roomChannel = getRoomChannel(result.roomId)

      if (targetSocketId) {
        const targetSocket = io.sockets.sockets.get(targetSocketId)
        if (targetSocket) {
          targetSocket.leave(roomChannel)
        }
        io.to(targetSocketId).emit(EVENTS.server.ROOM_LEFT, {
          roomId: result.roomId,
          reason: 'kick',
        })
      }

      io.to(roomChannel).emit(EVENTS.server.ROOM_PLAYER_LEFT, {
        player: result.removedPlayer,
        room: result.roomState,
        reason: result.reason,
      })
      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
        room: result.roomState,
      })

      if (result.hostChanged) {
        io.to(roomChannel).emit(EVENTS.server.ROOM_HOST_CHANGED, {
          player: result.hostChanged,
          room: result.roomState,
        })
      }

      handleSuccess(ack, {
        room: result.roomState,
        player: result.removedPlayer,
      })
    } catch (error) {
      handleError(EVENTS.client.ROOM_KICK_PLAYER, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_START_GAME, (payload = {}, ack) => {
    try {
      const result = roomManager.startGame(socket.data.playerId)
      const roomChannel = getRoomChannel(result.room.id)

      result.room.players.forEach((player) => {
        const targetSocketId = roomManager.getActiveSocketId(player.id)
        if (!targetSocketId) {
          return
        }

        io.to(targetSocketId).emit(
          EVENTS.server.GAME_STARTED,
          roomManager.getReconnectGameSnapshot(result.room.id, player.id)
        )
      })

      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
        room: result.roomState,
      })

      handleSuccess(ack, { room: result.roomState })
    } catch (error) {
      handleError(EVENTS.client.ROOM_START_GAME, ack, error)
    }
  })

  socket.on(EVENTS.client.RECONNECT_ABANDON, (payload = {}, ack) => {
    try {
      const roomId = roomManager.getRoomIdForPlayer(socket.data.playerId)
      if (!roomId) {
        handleSuccess(ack, { roomId: null })
        return
      }

      const result = roomManager.abandonReconnect(socket.data.playerId)
      socket.leave(getRoomChannel(roomId))
      socket.emit(EVENTS.server.ROOM_LEFT, { roomId })

      if (result && result.roomState) {
        const roomChannel = getRoomChannel(roomId)
        io.to(roomChannel).emit(EVENTS.server.ROOM_PLAYER_LEFT, {
          player: result.removedPlayer,
          room: result.roomState,
        })
        io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
          room: result.roomState,
        })

        if (result.hostChanged) {
          io.to(roomChannel).emit(EVENTS.server.ROOM_HOST_CHANGED, {
            player: result.hostChanged,
            room: result.roomState,
          })
        }
      }

      emitGameAction(roomId, result && result.gameAction)

      handleSuccess(ack, {
        roomId,
        room: result ? result.roomState : null,
      })
    } catch (error) {
      handleError(EVENTS.client.RECONNECT_ABANDON, ack, error)
    }
  })
}

module.exports = registerRoomHandlers
