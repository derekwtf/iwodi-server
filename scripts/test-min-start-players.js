const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')

const wordLibrary = {
  getRandomPair() {
    return {
      index: 1,
      groupId: 'test',
      categoryId: 'test',
      categoryLabel: '测试',
      candidateWords: ['甲', '乙'],
      civilian: '甲',
      spy: '乙',
    }
  },
}

function addPlayer(manager, roomId, socketId) {
  const { playerId } = manager.registerConnection({ socketId })
  if (roomId) {
    manager.joinRoom(roomId, { playerId, nickname: socketId })
  }
  return playerId
}

function createRoom(manager, gameMode, socketId) {
  const hostId = addPlayer(manager, null, socketId)
  const { room } = manager.createRoom({
    playerId: hostId,
    nickname: '房主',
    gameMode,
  })
  return { roomId: room.id, hostId }
}

function assertTooFewPlayers(manager, hostId, count) {
  assert.throws(
    () => manager.startGame(hostId),
    (error) => error.code === 'NOT_ENOUGH_PLAYERS' &&
      error.message === `至少需要 ${count} 人才能开始游戏`
  )
}

function testDefault() {
  const manager = new RoomManager({ wordLibrary })
  const { roomId, hostId } = createRoom(manager, 'deal-only', 'default-host')
  assert.strictEqual(manager.getRoomState(roomId).minStartPlayers, 4)
  addPlayer(manager, roomId, 'default-guest-1')
  addPlayer(manager, roomId, 'default-guest-2')
  assertTooFewPlayers(manager, hostId, 4)
  addPlayer(manager, roomId, 'default-guest-3')
  assert.strictEqual(manager.startGame(hostId).roomState.status, 'playing')
  manager.destroyRoom(roomId)
}

function testConfiguredMinimum() {
  const manager = new RoomManager({ wordLibrary, minStartPlayers: '2' })
  const { roomId, hostId } = createRoom(manager, 'deal-only', 'two-host')
  assert.strictEqual(manager.getRoomState(roomId).minStartPlayers, 2)
  assertTooFewPlayers(manager, hostId, 2)
  const guestId = addPlayer(manager, roomId, 'two-guest')
  assert.strictEqual(manager.getSyncState(guestId).room.minStartPlayers, 2)
  const reconnect = manager.registerConnection({
    playerId: hostId,
    socketId: 'two-host-reconnected',
  })
  assert.strictEqual(reconnect.reconnectEvent.payload.minStartPlayers, 2)
  const started = manager.startGame(hostId)
  assert.strictEqual(started.roomState.minStartPlayers, 2)
  assert.strictEqual(manager.getReconnectGameSnapshot(roomId, guestId).phase, 'dealing')
  const restarted = manager.restartGame(hostId)
  assert.strictEqual(restarted.roomState.status, 'waiting')
  assert.strictEqual(restarted.roomState.minStartPlayers, 2)
  assert.strictEqual(manager.startGame(hostId).roomState.status, 'playing')
  manager.destroyRoom(roomId)

  const fullManager = new RoomManager({ wordLibrary, minStartPlayers: 2 })
  const fullRoom = createRoom(fullManager, 'full', 'full-host')
  addPlayer(fullManager, fullRoom.roomId, 'full-guest')
  assert.strictEqual(fullManager.startGame(fullRoom.hostId).roomState.minStartPlayers, 2)
  fullManager.destroyRoom(fullRoom.roomId)
}

function testInvalidValues() {
  for (const value of [undefined, null, '', 'abc', '2.5', '2.0', '2e0', 1, 13]) {
    const manager = new RoomManager({ wordLibrary, minStartPlayers: value })
    assert.strictEqual(manager.minStartPlayers, 4, `Invalid value: ${value}`)
  }
  assert.strictEqual(new RoomManager({ minStartPlayers: '12' }).minStartPlayers, 12)
}

testDefault()
testConfiguredMinimum()
testInvalidValues()
console.log('Minimum start players test passed.')
