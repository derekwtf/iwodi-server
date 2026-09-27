const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')
const Judge = require('../src/game/Judge')

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
  assert.strictEqual(fullManager.getRoomState(fullRoom.roomId).minStartPlayers, 3)
  const fullGuestId = addPlayer(fullManager, fullRoom.roomId, 'full-guest')
  assertTooFewPlayers(fullManager, fullRoom.hostId, 3)
  assert.strictEqual(fullManager.getRoomState(fullRoom.roomId).status, 'waiting')
  assert.strictEqual(fullManager.rooms.get(fullRoom.roomId).gameState, null)
  assert.strictEqual(fullManager.getSyncState(fullGuestId).room.minStartPlayers, 3)
  const fullReconnect = fullManager.registerConnection({
    playerId: fullRoom.hostId,
    socketId: 'full-host-reconnected',
  })
  assert.strictEqual(fullReconnect.reconnectEvent.payload.minStartPlayers, 3)
  addPlayer(fullManager, fullRoom.roomId, 'full-third')
  const fullStarted = fullManager.startGame(fullRoom.hostId)
  assert.strictEqual(fullStarted.roomState.minStartPlayers, 3)
  assert.strictEqual(fullStarted.roomState.status, 'playing')
  const gameState = fullManager.rooms.get(fullRoom.roomId).gameState
  assert.deepStrictEqual(Judge.checkGameOver(gameState.alivePlayers, gameState.roles), {
    gameOver: false,
    winner: null,
  })
  const leavingCivilian = gameState.alivePlayers.find(
    (playerId) => playerId !== fullRoom.hostId && gameState.roles[playerId] === 'civilian'
  )
  const ended = fullManager.leaveRoom(fullRoom.roomId, leavingCivilian)
  assert.strictEqual(ended.gameAction.type, 'ended')
  assert.strictEqual(ended.gameAction.payload.room.minStartPlayers, 3)
  const fullRestarted = fullManager.restartGame(fullRoom.hostId)
  assert.strictEqual(fullRestarted.roomState.status, 'waiting')
  assert.strictEqual(fullRestarted.roomState.minStartPlayers, 3)
  assertTooFewPlayers(fullManager, fullRoom.hostId, 3)
  assert.strictEqual(fullManager.getRoomState(fullRoom.roomId).status, 'waiting')
  fullManager.destroyRoom(fullRoom.roomId)
}

function testConfiguredThresholds() {
  for (const configuredMinimum of [2, 3, 4, 5, 12]) {
    for (const gameMode of ['deal-only', 'full']) {
      const manager = new RoomManager({ wordLibrary, minStartPlayers: configuredMinimum })
      const { roomId, hostId } = createRoom(
        manager, gameMode, `threshold-${configuredMinimum}-${gameMode}-host`
      )
      const expectedMinimum = gameMode === 'full'
        ? Math.max(configuredMinimum, 3)
        : configuredMinimum
      assert.strictEqual(manager.getRoomState(roomId).minStartPlayers, expectedMinimum)

      for (let count = 1; count < expectedMinimum; count += 1) {
        assertTooFewPlayers(manager, hostId, expectedMinimum)
        assert.strictEqual(manager.getRoomState(roomId).status, 'waiting')
        assert.strictEqual(manager.rooms.get(roomId).gameState, null)
        addPlayer(manager, roomId, `threshold-${configuredMinimum}-${gameMode}-${count}`)
      }

      const started = manager.startGame(hostId)
      assert.strictEqual(started.roomState.status, 'playing')
      assert.strictEqual(started.roomState.minStartPlayers, expectedMinimum)
      manager.destroyRoom(roomId)
    }
  }
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
testConfiguredThresholds()
testInvalidValues()
console.log('Minimum start players test passed.')
