const EVENTS = require('./events')
const { getUserState, resolveStoredProfile } = require('../user/profile')
const { handleError, handleSuccess, requireActiveConnection } = require('./helpers')

function registerUserHandlers(io, socket, roomManager, getRoomChannel, userStore) {
  let expiryTimer

  function syncUser(user, { markActive = false, error } = {}) {
    const previous = socket.data.profile
    socket.data.profile = user
    const changed = ['nickname', 'avatar', 'vipExpiresAt', 'lastNormalAvatar']
      .some((key) => previous[key] !== user[key]) || previous.isVip !== user.isVip
    let result = null
    if ((changed || markActive) && roomManager.getRoomIdForPlayer(socket.data.playerId)) {
      result = roomManager.updatePlayerProfile(socket.data.playerId, user, { markActive })
      const channel = getRoomChannel(result.room.id)
      io.to(channel).emit(EVENTS.server.ROOM_STATE, { room: result.roomState })
      if (result.gameState) io.to(channel).emit(EVENTS.server.GAME_STATE_SYNC, result.gameState)
    }
    const state = getUserState(user)
    socket.emit(EVENTS.server.USER_STATE, { ...state, ...(error ? { error } : {}) })
    clearTimeout(expiryTimer)
    if (user.isVip) {
      expiryTimer = setTimeout(() => {
        try {
          requireActiveConnection(socket, roomManager)
          const latest = userStore.getUser(socket.data.userId)
          if (!latest) throw new Error('用户不存在')
          syncUser(latest)
        } catch (_) {
          // 到期时数据库故障也先撤下缓存中的 VIP 外观，不阻塞普通游戏。
          syncUser(resolveStoredProfile(socket.data.profile), {
            error: { message: '暂时无法获取 VIP 状态' },
          })
        }
      }, Math.min(Math.max(user.vipExpiresAt - Date.now(), 1), 2147483647))
      expiryTimer.unref()
    }
    return { ...state, ...(result ? { room: result.roomState, gameState: result.gameState } : {}),
      player: result ? result.player : { ...state.profile, isVip: user.isVip } }
  }

  socket.on(EVENTS.client.USER_SYNC_STATE, (payload, ack) => {
    try {
      const user = userStore.getUser(socket.data.userId)
      if (!user) throw Object.assign(new Error('登录已失效'), { code: 'AUTH_INVALID' })
      handleSuccess(ack, syncUser(user))
    } catch (error) {
      handleError(socket, EVENTS.client.USER_SYNC_STATE, ack, error)
    }
  })

  function saveProfile(payload = {}, ack, requireRoom = false) {
    const event = requireRoom ? EVENTS.client.ROOM_UPDATE_PROFILE : EVENTS.client.USER_UPDATE_PROFILE
    try {
      requireActiveConnection(socket, roomManager)
      if (requireRoom) roomManager.requireProfileMember(socket.data.playerId)
      const user = userStore.updateProfile(socket.data.userId, {
        nickname: payload.nickname, avatar: payload.avatar,
      })
      handleSuccess(ack, syncUser(user, { markActive: true }))
    } catch (error) {
      handleError(socket, event, ack, error)
    }
  }

  socket.on(EVENTS.client.USER_UPDATE_PROFILE, (payload, ack) => saveProfile(payload, ack))
  socket.on(EVENTS.client.ROOM_UPDATE_PROFILE, (payload, ack) => saveProfile(payload, ack, true))
  socket.on('disconnect', () => clearTimeout(expiryTimer))
  syncUser(socket.data.profile)
}

module.exports = registerUserHandlers
