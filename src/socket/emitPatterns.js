const EVENTS = require('./events')

function emitPlayerLeftSequence(
  io,
  roomChannel,
  { removedPlayer, roomState, hostChanged, reason }
) {
  if (!roomChannel || !roomState || !removedPlayer) {
    return
  }

  io.to(roomChannel).emit(EVENTS.server.ROOM_PLAYER_LEFT, {
    player: removedPlayer,
    room: roomState,
    reason,
  })
  io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
    room: roomState,
  })

  if (hostChanged) {
    io.to(roomChannel).emit(EVENTS.server.ROOM_HOST_CHANGED, {
      player: hostChanged,
      room: roomState,
    })
  }
}

module.exports = {
  emitPlayerLeftSequence,
}
