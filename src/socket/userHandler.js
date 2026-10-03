const EVENTS = require('./events')
const { handleError, handleSuccess, requireActiveConnection } = require('./helpers')

function registerUserHandlers(socket, roomManager, userStore, paymentService, syncProfile) {
  const syncUser = (user, options) => syncProfile(socket.data.playerId, user, options)

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
  if (paymentService) {
    let querying = false
    for (const [event, method] of [
      [EVENTS.client.USER_CREATE_VIP_ORDER, 'create'], [EVENTS.client.USER_QUERY_VIP_ORDER, 'queryOwn'],
    ]) {
      socket.on(event, async (payload, ack) => {
        if (querying) return handleError(socket, event, ack, Object.assign(new Error('订单处理中，请稍后刷新'), { code: 'VIP_ORDER_BUSY' }))
        querying = true
        try {
          requireActiveConnection(socket, roomManager)
          const result = await paymentService[method](socket.data.userId, payload || {}, () =>
            roomManager.getActiveSocketId(socket.data.playerId) === socket.id)
          requireActiveConnection(socket, roomManager)
          const user = userStore.getUser(socket.data.userId)
          handleSuccess(ack, { ...result, ...syncUser(user) })
        } catch (error) { handleError(socket, event, ack, error) }
        finally { querying = false }
      })
    }
  }
  syncUser(socket.data.profile)
}

module.exports = registerUserHandlers
