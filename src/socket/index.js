const EVENTS = require('./events')
const { clearVoteTimers, handleError, requireActiveConnection } = require('./helpers')
const registerRoomHandlers = require('./roomHandler')
const registerGameHandlers = require('./gameHandler')
const registerUserHandlers = require('./userHandler')
const { getUserState } = require('../user/profile')

function getRoomChannel(roomId) {
  return `room:${roomId}`
}

function initializeSocketServer(io, roomManager, { userStore, tokens }) {
  const voteTimerStore = new Map()

  io.use((socket, next) => {
    try {
      const { userId } = tokens.verify(socket.handshake.auth?.token)
      const user = userStore.getUser(userId)
      if (!user) throw Object.assign(new Error('登录已失效，请重新登录'), { code: 'AUTH_INVALID' })
      socket.data.userId = userId
      socket.data.profile = user
      next()
    } catch (error) {
      error.data = { code: error.code || 'USER_STORE_UNAVAILABLE' }
      next(error)
    }
  })

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

  io.on('connection', (socket) => {
    const playerId = socket.handshake.auth?.playerId || null
    const connection = roomManager.registerConnection({
      playerId,
      socketId: socket.id,
      identityKey: socket.data.userId,
      profile: socket.data.profile,
    })

    if (connection.previousSocketId) {
      const previousSocket = io.sockets.sockets.get(connection.previousSocketId)
      if (previousSocket) {
        previousSocket.disconnect(true)
      }
    }

    socket.data.playerId = connection.playerId

    // 排队中的旧连接事件也不得在连接被替换后继续操作房间。
    socket.use(([action, ...args], next) => {
      try {
        requireActiveConnection(socket, roomManager)
        next()
      } catch (error) {
        handleError(socket, action, args[args.length - 1], error)
      }
    })

    const roomId = roomManager.getRoomIdForPlayer(connection.playerId)
    if (roomId) {
      socket.join(getRoomChannel(roomId))
    }

    socket.emit(EVENTS.server.CONNECT_SUCCESS, {
      playerId: connection.playerId,
      ...getUserState(socket.data.profile),
    })

    if (connection.reconnectEvent) {
      socket.emit(connection.reconnectEvent.event, connection.reconnectEvent.payload)
    }
    if (roomId) {
      socket.to(getRoomChannel(roomId)).emit(EVENTS.server.ROOM_STATE, {
        room: roomManager.getRoomState(roomId),
      })
      const game = roomManager.getGamePublicState(roomId, {
        includeEndedSecrets: true,
      })
      if (game) socket.to(getRoomChannel(roomId)).emit(EVENTS.server.GAME_STATE_SYNC, game)
    }

    registerRoomHandlers(io, socket, roomManager, getRoomChannel, voteTimerStore)
    registerUserHandlers(io, socket, roomManager, getRoomChannel, userStore)
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
