const { publishLeaveResult, emitPlayerLeftSequence } = require('./emitPatterns')
const { emitGameAction } = require('./helpers')

// Called synchronously after UserStore commits deletion. Removing the identity
// mapping also invalidates async Socket handlers waiting on platform responses.
function deleteAccountSession(io, roomManager, userId) {
  const registry = roomManager.sessionRegistry
  const playerId = registry.identityToPlayer.get(userId)
  const session = registry.get(playerId)
  const socket = io.sockets.sockets.get(session?.socketId)
  const result = playerId ? roomManager.leaveRoomByPlayerId(playerId, { reason: 'account_deleted' }) : null
  const historicalChanges = roomManager.forgetIdentityHistory(userId, playerId)
  registry.removeIdentity(userId)
  const getRoomChannel = (roomId) => `room:${roomId}`
  if (socket) publishLeaveResult(io, socket, getRoomChannel, result, { notifyLeaver: true })
  else if (result) {
    emitPlayerLeftSequence(io, getRoomChannel(result.roomId), result)
    emitGameAction(io, getRoomChannel, result.roomId, result.gameAction)
  }
  for (const change of historicalChanges) emitGameAction(io, getRoomChannel, change.roomId, { payload: change.payload })
  for (const active of io.sockets.sockets.values()) {
    if (active.data.userId !== userId) continue
    active.data.userId = null
    active.data.profile = null
    active.disconnect(true)
  }
}

module.exports = deleteAccountSession
