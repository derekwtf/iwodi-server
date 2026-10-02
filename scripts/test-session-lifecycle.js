const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')

const DAY_MS = 24 * 60 * 60 * 1000

function testConnectionReplacementAndExpiry() {
  const manager = new RoomManager()
  const playerId = manager.resolvePlayerIdByIdentity('wx:player')
  manager.registerConnection({ playerId, identityKey: 'wx:player', socketId: 'socket-old' })
  const { room } = manager.createRoom({ playerId, nickname: '玩家' })

  const replacement = manager.registerConnection({ playerId, identityKey: 'wx:player', socketId: 'socket-new' })
  assert.strictEqual(replacement.previousSocketId, 'socket-old')
  assert.strictEqual(replacement.reconnectEvent.event, 'reconnect:roomState')
  assert.strictEqual(manager.getActiveSocketId(playerId), 'socket-new')
  assert.strictEqual(manager.getPlayerIdBySocketId('socket-old'), null)
  assert.strictEqual(manager.markDisconnected('socket-old'), null)
  assert.strictEqual(manager.getRoomState(room.id).players[0].disconnected, false)

  manager.markDisconnected('socket-new')
  const disconnectedAt = manager.sessionRegistry.get(playerId).disconnectedAt
  assert.strictEqual(manager.cleanupExpiredSessions(disconnectedAt + DAY_MS), 0)
  assert.strictEqual(manager.getRoomIdForPlayer(playerId), room.id)

  manager.destroyRoom(room.id)
  assert.strictEqual(manager.getRoomIdForPlayer(playerId), null)
  assert.strictEqual(manager.cleanupExpiredSessions(disconnectedAt + DAY_MS - 1), 0)
  assert.strictEqual(manager.cleanupExpiredSessions(disconnectedAt + DAY_MS), 1)
  assert.strictEqual(manager.sessionRegistry.identityToPlayer.has('wx:player'), false)

  const reloginId = manager.resolvePlayerIdByIdentity('wx:player')
  assert.notStrictEqual(reloginId, playerId)
  const expired = manager.registerConnection({ playerId, identityKey: 'wx:player', socketId: 'socket-expired' })
  assert.notStrictEqual(expired.playerId, playerId)
  assert.deepStrictEqual(expired.reconnectEvent, {
    event: 'reconnect:expired',
    payload: { reason: 'session_not_found', previousPlayerId: playerId },
  })
}

function testOnlineAndClosedRoomSessions() {
  const manager = new RoomManager()
  const onlineId = manager.registerConnection({ socketId: 'online', identityKey: 'online' }).playerId
  assert.strictEqual(manager.cleanupExpiredSessions(Date.now() + DAY_MS + 1), 0)
  assert.strictEqual(manager.getActiveSocketId(onlineId), 'online')

  const hostId = manager.registerConnection({ socketId: 'host', identityKey: 'host' }).playerId
  const guestId = manager.registerConnection({ socketId: 'guest', identityKey: 'guest' }).playerId
  const { room } = manager.createRoom({ playerId: hostId, nickname: '房主' })
  manager.joinRoom(room.id, { playerId: guestId, nickname: '访客' })
  manager.markDisconnected('guest')
  manager.on('room:closed', ({ roomId }) => {
    assert.strictEqual(roomId, room.id)
    assert.strictEqual(manager.getRoomIdForPlayer(hostId), null)
    assert.strictEqual(manager.getRoomIdForPlayer(guestId), null)
  })
  manager.closeRoom(room.id)
  assert.strictEqual(manager.getRoomIdForPlayer(hostId), null)
  assert.strictEqual(manager.getRoomIdForPlayer(guestId), null)
  assert.strictEqual(manager.cleanupExpiredSessions(Date.now() + DAY_MS + 1), 1)
  assert.strictEqual(manager.getActiveSocketId(hostId), 'host')
}

function testDirectAndEmptyRoomDestruction() {
  const manager = new RoomManager()
  const hostId = manager.registerConnection({ socketId: 'host-a', identityKey: 'host-a' }).playerId
  const guestId = manager.registerConnection({ socketId: 'guest-a', identityKey: 'guest-a' }).playerId
  const otherId = manager.registerConnection({ socketId: 'host-b', identityKey: 'host-b' }).playerId
  const roomA = manager.createRoom({ playerId: hostId, nickname: '房主甲' }).room
  manager.joinRoom(roomA.id, { playerId: guestId, nickname: '访客甲' })
  const roomB = manager.createRoom({ playerId: otherId, nickname: '房主乙' }).room

  assert.strictEqual(manager.destroyRoom(roomA.id), true)
  assert.strictEqual(manager.getRoomState(roomA.id), null)
  assert.strictEqual(manager.getRoomIdForPlayer(hostId), null)
  assert.strictEqual(manager.getRoomIdForPlayer(guestId), null)
  assert.strictEqual(manager.getRoomIdForPlayer(otherId), roomB.id)
  assert.strictEqual(manager.destroyRoom(roomA.id), false)

  manager.leaveRoom(roomB.id, otherId)
  assert.strictEqual(manager.getRoomState(roomB.id), null)
  assert.strictEqual(manager.getRoomIdForPlayer(otherId), null)
}

function testDestroyRoomPreservesUpdatedSessionRoom() {
  const manager = new RoomManager()
  const playerId = manager.registerConnection({ socketId: 'stale-member', identityKey: 'stale-member' }).playerId
  const { room } = manager.createRoom({ playerId, nickname: '玩家' })

  // 模拟房间玩家记录尚未移除，但会话已经指向另一间房。
  manager.sessionRegistry.get(playerId).roomId = 'new-room'
  manager.destroyRoom(room.id)
  assert.strictEqual(manager.getRoomIdForPlayer(playerId), 'new-room')
}

testConnectionReplacementAndExpiry()
testOnlineAndClosedRoomSessions()
testDirectAndEmptyRoomDestruction()
testDestroyRoomPreservesUpdatedSessionRoom()
console.log('Session lifecycle test passed.')
