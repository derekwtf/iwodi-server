const EVENTS = require('./events')
const { getUserState, resolveStoredProfile } = require('../user/profile')

function createUserSync(io, roomManager, getRoomChannel, { userStore, paymentService }) {
  const expiryTimers = new Map()
  function clearExpiryTimer(socketId) {
    clearTimeout(expiryTimers.get(socketId))
    expiryTimers.delete(socketId)
  }

  function syncUser(playerId, user, { markActive = false, error } = {}) {
    const socket = io.sockets.sockets.get(roomManager.getActiveSocketId(playerId))
    const previous = socket?.data.profile
    const member = roomManager.getRoomIdForPlayer(playerId)
      ? roomManager.requireProfileMember(playerId).player : null
    const changed = member && (['nickname', 'avatar', 'vipExpiresAt', 'lastNormalAvatar']
      .some((key) => member[key] !== user[key]) || (previous && previous.isVip !== user.isVip))
    let result = null
    if (member && (changed || markActive)) {
      result = roomManager.updatePlayerProfile(playerId, user, { markActive })
      const channel = getRoomChannel(result.room.id)
      io.to(channel).emit(EVENTS.server.ROOM_STATE, { room: result.roomState })
      if (result.gameState) io.to(channel).emit(EVENTS.server.GAME_STATE_SYNC, result.gameState)
    }
    const state = getUserState(user, paymentService?.product)
    if (socket) {
      socket.data.profile = user
      socket.emit(EVENTS.server.USER_STATE, { ...state, ...(error ? { error } : {}) })
      clearExpiryTimer(socket.id)
      if (user.isVip) {
        const timer = setTimeout(() => {
          expiryTimers.delete(socket.id)
          if (roomManager.getActiveSocketId(playerId) !== socket.id) return
          try {
            const latest = userStore.getUser(socket.data.userId)
            if (!latest) throw new Error('用户不存在')
            syncUser(playerId, latest)
          } catch (_) {
            // 到期时数据库故障也先撤下缓存中的 VIP 外观，不阻塞普通游戏。
            syncUser(playerId, resolveStoredProfile(socket.data.profile), {
              error: { message: '暂时无法获取 VIP 状态' },
            })
          }
        }, Math.min(Math.max(user.vipExpiresAt - Date.now(), 1), 2147483647))
        timer.unref()
        expiryTimers.set(socket.id, timer)
      }
    }
    return { ...state, ...(result ? { room: result.roomState, gameState: result.gameState } : {}),
      player: result ? result.player : { ...state.profile, isVip: user.isVip } }
  }

  return { syncUser, clearExpiryTimer }
}

function requireActiveConnection(socket, roomManager) {
  if (!socket.data.userId || roomManager.getActiveSocketId(socket.data.playerId) !== socket.id) {
    throw Object.assign(new Error('连接已失效，请重试'), { code: 'SESSION_REPLACED' })
  }
}

function emitGameAction(io, getRoomChannel, roomId, gameAction) {
  if (!roomId || !gameAction || !gameAction.payload) return
  io.to(getRoomChannel(roomId)).emit(EVENTS.server.GAME_STATE_SYNC, gameAction.payload)
}

function handleError(socket, action, ack, error) {
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

function handleSuccess(ack, payload) {
  if (typeof ack === 'function') {
    ack({
      ok: true,
      ...payload,
    })
  }
}

module.exports = {
  createUserSync,
  requireActiveConnection,
  emitGameAction,
  handleError,
  handleSuccess,
}
