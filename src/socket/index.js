const EVENTS = require('./events')
const { emitPlayerLeftSequence } = require('./emitPatterns')
const { clearVoteTimers, emitGameAction } = require('./helpers')
const registerRoomHandlers = require('./roomHandler')
const registerGameHandlers = require('./gameHandler')

function getRoomChannel(roomId) {
  return `room:${roomId}`
}

function initializeSocketServer(io, roomManager) {
  const voteTimerStore = new Map()

  roomManager.on('room:destroyed', ({ roomId }) => {
    clearVoteTimers(voteTimerStore, roomId)
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

  roomManager.on('room:hostTransferred', (payload) => {
    if (!payload || !payload.roomId) {
      return
    }

    io.to(getRoomChannel(payload.roomId)).emit(EVENTS.server.ROOM_HOST_CHANGED, {
      player: payload.player,
      previousPlayer: payload.previousPlayer,
      room: payload.roomState,
      reason: payload.reason,
    })
  })

  roomManager.on('player:disconnectTimeout', (payload) => {
    if (!payload || !payload.roomId) {
      return
    }

    const roomChannel = getRoomChannel(payload.roomId)
    if (payload.roomState) {
      emitPlayerLeftSequence(io, roomChannel, {
        removedPlayer: payload.removedPlayer,
        roomState: payload.roomState,
        hostChanged: payload.hostChanged,
        reason: payload.reason,
      })
    }

    emitGameAction(io, getRoomChannel, payload.roomId, payload.gameAction, {
      onTerminalAction: (targetRoomId) => clearVoteTimers(voteTimerStore, targetRoomId),
    })
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
