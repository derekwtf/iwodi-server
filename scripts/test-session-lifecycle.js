const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')

const DAY_MS = 24 * 60 * 60 * 1000

function testConnectionReplacementAndExpiry() {
  const manager = new RoomManager()
  const playerId = manager.resolvePlayerIdByIdentity('wx:player')
  manager.registerConnection({ playerId, socketId: 'socket-old' })
  const { room } = manager.createRoom({ playerId, nickname: '玩家' })

  const replacement = manager.registerConnection({ playerId, socketId: 'socket-new' })
  assert.strictEqual(replacement.previousSocketId, 'socket-old')
  assert.strictEqual(replacement.reconnectEvent.event, 'reconnect:roomState')
  assert.strictEqual(manager.getActiveSocketId(playerId), 'socket-new')
  assert.strictEqual(manager.getPlayerIdBySocketId('socket-old'), null)
  assert.strictEqual(manager.markDisconnected('socket-old'), null)
  assert.strictEqual(manager.getRoomState(room.id).players[0].disconnected, false)

  manager.markDisconnected('socket-new')
  assert.strictEqual(manager.cleanupExpiredSessions(Date.now() + DAY_MS + 1), 0)
  assert.strictEqual(manager.getRoomIdForPlayer(playerId), room.id)

  manager.destroyRoom(room.id)
  assert.strictEqual(manager.getRoomIdForPlayer(playerId), null)
  assert.strictEqual(manager.cleanupExpiredSessions(Date.now() + DAY_MS - 1), 0)
  assert.strictEqual(manager.cleanupExpiredSessions(Date.now() + DAY_MS + 1), 1)
  assert.strictEqual(manager.sessionRegistry.identityToPlayer.has('wx:player'), false)

  const reloginId = manager.resolvePlayerIdByIdentity('wx:player')
  assert.notStrictEqual(reloginId, playerId)
  const expired = manager.registerConnection({ playerId, socketId: 'socket-expired' })
  assert.notStrictEqual(expired.playerId, playerId)
  assert.deepStrictEqual(expired.reconnectEvent, {
    event: 'reconnect:expired',
    payload: { reason: 'session_not_found', previousPlayerId: playerId },
  })
}

function testOnlineAndClosedRoomSessions() {
  const manager = new RoomManager()
  const onlineId = manager.registerConnection({ socketId: 'online' }).playerId
  assert.strictEqual(manager.cleanupExpiredSessions(Date.now() + DAY_MS + 1), 0)
  assert.strictEqual(manager.getActiveSocketId(onlineId), 'online')

  const hostId = manager.registerConnection({ socketId: 'host' }).playerId
  const guestId = manager.registerConnection({ socketId: 'guest' }).playerId
  const { room } = manager.createRoom({ playerId: hostId, nickname: '房主' })
  manager.joinRoom(room.id, { playerId: guestId, nickname: '访客' })
  manager.markDisconnected('guest')
  manager.closeRoom(room.id)
  assert.strictEqual(manager.getRoomIdForPlayer(hostId), null)
  assert.strictEqual(manager.getRoomIdForPlayer(guestId), null)
  assert.strictEqual(manager.cleanupExpiredSessions(Date.now() + DAY_MS + 1), 1)
  assert.strictEqual(manager.getActiveSocketId(hostId), 'host')
}

testConnectionReplacementAndExpiry()
testOnlineAndClosedRoomSessions()
console.log('Session lifecycle test passed.')
