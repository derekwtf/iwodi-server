const EVENTS = require('./events')

function clearVoteTimers(voteTimerStore, roomId) {
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

function emitGameAction(io, getRoomChannel, roomId, gameAction, options = {}) {
  if (!roomId || !gameAction || !gameAction.payload) {
    return
  }

  const { onTerminalAction } = options
  const roomChannel = getRoomChannel(roomId)
  switch (gameAction.type) {
    case 'speakingStarted':
      io.to(roomChannel).emit(EVENTS.server.GAME_SPEAKING_STARTED, gameAction.payload)
      if (typeof onTerminalAction === 'function') {
        onTerminalAction(roomId)
      }
      break
    case 'result':
      io.to(roomChannel).emit(EVENTS.server.GAME_RESULT, gameAction.payload)
      if (typeof onTerminalAction === 'function') {
        onTerminalAction(roomId)
      }
      break
    case 'ended':
      io.to(roomChannel).emit(EVENTS.server.GAME_ENDED, gameAction.payload)
      if (typeof onTerminalAction === 'function') {
        onTerminalAction(roomId)
      }
      break
    case 'stateSync':
    default:
      io.to(roomChannel).emit(EVENTS.server.GAME_STATE_SYNC, gameAction.payload)
      break
  }
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
  clearVoteTimers,
  emitGameAction,
  handleError,
  handleSuccess,
}
