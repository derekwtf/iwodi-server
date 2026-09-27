const EVENTS = require('./events')
const { clearVoteTimers, emitGameAction } = require('./helpers')

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

function publishLeaveResult(io, socket, getRoomChannel, result, voteTimerStore, options = {}) {
  if (!result) return
  const { roomId, roomState, removedPlayer, hostChanged, reason, gameAction } = result
  const roomChannel = getRoomChannel(roomId)
  socket.leave(roomChannel)
  if (options.notifyLeaver) {
    socket.emit(EVENTS.server.ROOM_LEFT, { roomId })
  }
  if (roomState) {
    emitPlayerLeftSequence(io, roomChannel, {
      removedPlayer,
      roomState,
      hostChanged,
      reason,
    })
  }
  emitGameAction(io, getRoomChannel, roomId, gameAction, {
    onTerminalAction: (targetRoomId) => clearVoteTimers(voteTimerStore, targetRoomId),
  })
}

module.exports = {
  emitPlayerLeftSequence,
  publishLeaveResult,
}
