const EVENTS = require('./events')
const { handleError, handleSuccess } = require('./helpers')

function registerGameHandlers(io, socket, roomManager, getRoomChannel) {
  socket.on(EVENTS.client.GAME_RESTART, (payload = {}, ack) => {
    try {
      const result = roomManager.restartGame(socket.data.playerId)
      io.to(getRoomChannel(result.room.id)).emit(EVENTS.server.GAME_RESTARTED, {
        room: result.roomState,
      })
      handleSuccess(ack, { room: result.roomState })
    } catch (error) {
      handleError(socket, EVENTS.client.GAME_RESTART, ack, error)
    }
  })
}

module.exports = registerGameHandlers
