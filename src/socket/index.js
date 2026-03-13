const EVENTS = require('./events')
const registerRoomHandlers = require('./roomHandler')
const registerGameHandlers = require('./gameHandler')

function getRoomChannel(roomId) {
  return `room:${roomId}`
}

function initializeSocketServer(io, roomManager) {
  const voteTimerStore = new Map()

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

  roomManager.on('room:destroyed', ({ roomId }) => {
    clearVoteTimers(roomId)
  })

  roomManager.on('room:idleWarning', (payload) => {
    if (!payload || !payload.roomId) {
      return
    }

    io.to(getRoomChannel(payload.roomId)).emit(
      EVENTS.server.ROOM_IDLE_WARNING,
      payload
    )
  })

  roomManager.on('room:closed', (payload) => {
    if (!payload || !payload.roomId) {
      return
    }

    const roomChannel = getRoomChannel(payload.roomId)
    io.to(roomChannel).emit(EVENTS.server.ROOM_CLOSED, {
      roomId: payload.roomId,
      reason: payload.reason,
      previousStatus: payload.previousStatus,
    })

    ;(payload.activePlayerIds || []).forEach((playerId) => {
      const socketId = roomManager.getActiveSocketId(playerId)
      if (!socketId) {
        return
      }

      const targetSocket = io.sockets.sockets.get(socketId)
      if (targetSocket) {
        targetSocket.leave(roomChannel)
      }
    })
  })

  const emitGameAction = (roomId, gameAction) => {
    if (!roomId || !gameAction || !gameAction.payload) {
      return
    }

    const roomChannel = getRoomChannel(roomId)
    switch (gameAction.type) {
      case 'speakingStarted':
        io.to(roomChannel).emit(EVENTS.server.GAME_SPEAKING_STARTED, gameAction.payload)
        clearVoteTimers(roomId)
        break
      case 'result':
        io.to(roomChannel).emit(EVENTS.server.GAME_RESULT, gameAction.payload)
        clearVoteTimers(roomId)
        break
      case 'ended':
        io.to(roomChannel).emit(EVENTS.server.GAME_ENDED, gameAction.payload)
        clearVoteTimers(roomId)
        break
      case 'stateSync':
      default:
        io.to(roomChannel).emit(EVENTS.server.GAME_STATE_SYNC, gameAction.payload)
        break
    }
  }

  roomManager.on('player:disconnectTimeout', (payload) => {
    if (!payload || !payload.roomId) {
      return
    }

    const roomChannel = getRoomChannel(payload.roomId)
    if (payload.roomState) {
      io.to(roomChannel).emit(EVENTS.server.ROOM_PLAYER_LEFT, {
        player: payload.removedPlayer,
        room: payload.roomState,
        reason: payload.reason,
      })
      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
        room: payload.roomState,
      })

      if (payload.hostChanged) {
        io.to(roomChannel).emit(EVENTS.server.ROOM_HOST_CHANGED, {
          player: payload.hostChanged,
          room: payload.roomState,
        })
      }
    }

    emitGameAction(payload.roomId, payload.gameAction)
  })

  io.on('connection', (socket) => {
    const playerId =
      socket.handshake.auth?.playerId || socket.handshake.query?.playerId || null
    const connection = roomManager.registerConnection({
      playerId,
      socketId: socket.id,
    })

    socket.data.playerId = connection.playerId

    const roomId = roomManager.getRoomIdForPlayer(connection.playerId)
    if (roomId) {
      socket.join(getRoomChannel(roomId))
    }

    socket.emit(EVENTS.server.CONNECT_SUCCESS, {
      playerId: connection.playerId,
    })

    if (connection.reconnectEvent) {
      socket.emit(connection.reconnectEvent.event, connection.reconnectEvent.payload)
    }

    registerRoomHandlers(io, socket, roomManager, getRoomChannel)
    registerGameHandlers(
      io,
      socket,
      roomManager,
      getRoomChannel,
      voteTimerStore
    )

    socket.on('disconnect', () => {
      const result = roomManager.markDisconnected(socket.id)
      if (!result || !result.roomId || !result.roomState) {
        return
      }

      io.to(getRoomChannel(result.roomId)).emit(
        EVENTS.server.ROOM_PLAYER_DISCONNECTED,
        {
          player: result.player,
          room: result.roomState,
          graceMs: result.graceMs,
        }
      )
      io.to(getRoomChannel(result.roomId)).emit(EVENTS.server.ROOM_STATE, {
        room: result.roomState,
      })
    })
  })
}

module.exports = {
  initializeSocketServer,
}
