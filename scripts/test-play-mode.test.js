const assert = require('node:assert/strict')
const { test } = require('node:test')
const RoomManager = require('../src/room/RoomManager')
const WordLibrary = require('../src/data/WordLibrary')
const BodyPromptLibrary = require('../src/data/BodyPromptLibrary')
const loadWordCategories = require('../src/data/loadWordCategories')
const path = require('node:path')

function fixture(context, count = 4, options = {}) {
  const manager = new RoomManager({
    wordLibrary: new WordLibrary(), bodyPromptLibrary: new BodyPromptLibrary(), ...options,
  })
  context.after(() => { for (const roomId of manager.rooms.keys()) manager.destroyRoom(roomId) })
  const playerIds = Array.from({ length: count }, (_, index) => manager.registerConnection({
    socketId: `socket-${index}`, identityKey: `identity-${index}`,
  }).playerId)
  const { room } = manager.createRoom({ playerId: playerIds[0], nickname: '房主', playMode: options.playMode || 'language' })
  for (const playerId of playerIds.slice(1)) manager.joinRoom(room.id, { playerId, nickname: playerId })
  return { manager, room, hostId: playerIds[0], playerIds }
}

for (const playMode of ['language', 'body']) {
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) test(`${playMode}: ${count} players obey product rules`, (context) => {
    const { manager, room, hostId } = fixture(context, count, { playMode, minStartPlayers: 2, maxPlayers: 99 })
    manager.setPlayMode(hostId, playMode)
    assert.equal(manager.getRoomState(room.id).minStartPlayers, 3)
    assert.equal(manager.getRoomState(room.id).maxPlayers, 12)
    assert.equal(room.spyCount, count >= 9 ? 2 : 1)
    if (count < 3) {
      const before = manager.getRoomState(room.id)
      assert.throws(() => manager.startGame(hostId, playMode), { code: 'NOT_ENOUGH_PLAYERS' })
      assert.deepEqual(manager.getRoomState(room.id), before)
      assert.equal(room.gameState, null)
      assert.deepEqual(room.usedPromptPairIds, { language: [], body: [] })
    } else {
      manager.startGame(hostId, playMode)
      assert.equal(room.gameState.playMode, playMode)
      assert.equal(Object.values(room.gameState.roles).filter((role) => role === 'spy').length,
        count >= 9 ? 2 : 1)
    }
  })
}

test('permissions, strict modes, locking, and failed changes are atomic', (context) => {
  const { manager, room, hostId, playerIds } = fixture(context, 6)
  manager.setSpyCount(hostId, 2)
  const before = manager.getRoomState(room.id)
  for (const invalid of [null, '', 'full', 'deal-only', '__proto__', 1, ['body'], {}]) {
    assert.throws(() => manager.setPlayMode(hostId, invalid), { code: 'INVALID_PLAY_MODE' })
    assert.throws(() => manager.createRoom({ playerId: hostId, playMode: invalid }), { code: 'INVALID_PLAY_MODE' })
    assert.equal(manager.getRoomIdForPlayer(hostId), room.id)
    assert.deepEqual(manager.getRoomState(room.id), before)
    assert.equal(room.spyCountManual, true)
  }
  assert.throws(() => manager.setPlayMode(playerIds[1], 'body'), { code: 'HOST_ONLY_ACTION' })
  manager.markDisconnected('socket-5')
  manager.setPlayMode(hostId, 'body')
  assert.equal(room.spyCount, 2)
  assert.equal(room.spyCountManual, true)
  assert.equal(room.playMode, 'body')
  assert.equal(manager.getRoomState(room.id).maxPlayers, before.maxPlayers)
  const activeAt = room.lastActivityAt
  manager.setPlayMode(hostId, 'body')
  assert.equal(room.lastActivityAt, activeAt)
  assert.equal(room.spyCount, 2)
  manager.leaveRoom(room.id, playerIds[5])
  manager.setPlayMode(hostId, 'body')
  assert.equal(room.spyCount, 1)
  assert.equal(room.spyCountManual, true)
  manager.setPlayMode(hostId, 'language')
  assert.equal(room.spyCount, 1)
  assert.throws(() => manager.startGame(hostId, 'body'), { code: 'PLAY_MODE_MISMATCH' })
  assert.throws(() => manager.startGame(hostId), { code: 'INVALID_PLAY_MODE' })
  manager.startGame(hostId, 'language')
  assert.throws(() => manager.setPlayMode(hostId, 'language'), { code: 'GAME_ALREADY_STARTED' })
  assert.throws(() => manager.setSpyCount(hostId, 1), { code: 'GAME_ALREADY_STARTED' })
  assert.throws(() => manager.restartGame(playerIds[1]), { code: 'HOST_ONLY_ACTION' })
})

for (const playMode of ['language', 'body']) test(`${playMode} rejects a thirteenth member without leaving their original room`, (context) => {
  const { manager, room } = fixture(context, 12, { playMode })
  const playerId = manager.registerConnection({ socketId: 'overflow', identityKey: 'overflow' }).playerId
  const original = manager.createRoom({ playerId }).room
  const before = manager.getRoomState(room.id)
  const originalBefore = manager.getRoomState(original.id)
  assert.throws(() => manager.joinRoom(room.id, { playerId }), { code: 'ROOM_FULL' })
  assert.equal(manager.getRoomIdForPlayer(playerId), original.id)
  assert.equal(room.players.length, 12)
  assert.deepEqual(manager.getRoomState(room.id), before)
  assert.deepEqual(manager.getRoomState(original.id), originalBefore)
})

for (const playMode of ['language', 'body']) {
  for (const [count, maxSpyCount] of [[3, 1], [5, 1], [6, 2], [8, 2], [9, 3], [12, 3]]) {
    test(`${playMode} spy bounds at ${count} players`, (context) => {
      const { manager, room, hostId, playerIds } = fixture(context, count, { playMode })
      assert.throws(() => manager.setSpyCount(playerIds[1], 1), { code: 'HOST_ONLY_ACTION' })
      for (const invalid of [0, -1, 1.5, '1', NaN, Infinity, maxSpyCount + 1]) {
        const before = room.spyCount
        assert.throws(() => manager.setSpyCount(hostId, invalid), { code: 'INVALID_SPY_COUNT' })
        assert.equal(room.spyCount, before)
      }
      for (let spyCount = 1; spyCount <= maxSpyCount; spyCount += 1) {
        manager.setSpyCount(hostId, spyCount)
        manager.startGame(hostId, playMode)
        assert.equal(Object.values(room.gameState.roles).filter((role) => role === 'spy').length, spyCount)
        manager.restartGame(hostId)
        assert.equal(room.spyCount, spyCount)
        assert.equal(room.spyCountManual, true)
      }
      room.spyCount = 1.5
      assert.throws(() => manager.startGame(hostId, playMode), { code: 'INVALID_SPY_COUNT' })
    })
  }
}

for (const count of [6, 7, 8, 9, 10, 11, 12]) {
  test(`mode switches preserve default and manual configuration with ${count} players`, (context) => {
    const { manager, room, hostId } = fixture(context, count)
    for (const spyCount of [null, 1, count >= 9 ? 3 : 2]) {
      if (spyCount !== null) manager.setSpyCount(hostId, spyCount)
      for (const playMode of ['body', 'language']) {
        manager.setPlayMode(hostId, playMode)
        assert.equal(room.playMode, playMode)
        assert.equal(room.spyCount, spyCount === null ? (count >= 9 ? 2 : 1) : spyCount)
        assert.equal(room.spyCountManual, spyCount !== null)
      }
    }
  })
}

for (const playMode of ['language', 'body']) {
  test(`${playMode} population changes refresh defaults and clamp manual counts without resetting them`, (context) => {
    const { manager, room, hostId, playerIds } = fixture(context, 12, { playMode })
    for (const playerId of playerIds.slice(8)) manager.leaveRoom(room.id, playerId)
    assert.equal(room.spyCount, 1)
    manager.joinRoom(room.id, { playerId: playerIds[8] })
    assert.equal(room.spyCount, 2)
    manager.setSpyCount(hostId, 1)
    manager.joinRoom(room.id, { playerId: playerIds[9] })
    assert.equal(room.spyCount, 1)
    manager.setSpyCount(hostId, 3)
    manager.startGame(hostId, playMode)
    manager.restartGame(hostId)
    assert.equal(room.spyCount, 3)
    for (const playerId of playerIds.slice(8, 10)) manager.leaveRoom(room.id, playerId)
    assert.equal(room.spyCount, 2)
    for (const playerId of playerIds.slice(5, 8)) manager.leaveRoom(room.id, playerId)
    assert.equal(room.spyCount, 1)
    assert.equal(room.spyCountManual, true)
    for (const playerId of playerIds.slice(5, 12)) manager.joinRoom(room.id, { playerId })
    assert.equal(room.spyCount, 1)
    assert.equal(room.spyCountManual, true)
    manager.startGame(hostId, playMode)
    manager.restartGame(hostId)
    assert.equal(room.spyCount, 1)
  })
}

test('body multi-spy snapshots, original reconnect cards, leave and restart', (context) => {
  const { manager, room, hostId, playerIds } = fixture(context, 6)
  manager.setPlayMode(hostId, 'body')
  manager.setSpyCount(hostId, 2)
  manager.startGame(hostId, 'body')
  const publicState = manager.getGamePublicState(room.id, { includeEndedSecrets: true })
  for (const key of ['wordPair', 'roles', 'playerWords', 'myWord', 'myRole', 'myPerformanceSteps',
    'playerPerformanceSteps', 'promptPairKey', 'groupId', 'round', 'speakOrder']) {
    assert.equal(key in publicState, false)
    assert.equal(key in manager.getRoomState(room.id), false)
  }
  const pair = manager.bodyPromptLibrary.wordGroups.find((group) => group.groupId === room.gameState.wordPair.groupId)
  const cardsByRole = {}
  for (const playerId of playerIds) {
    const snapshot = manager.getReconnectGameSnapshot(room.id, playerId)
    const variant = pair.variants.find((item) => item.text === snapshot.myWord)
    assert.deepEqual(snapshot.myPerformanceSteps, variant.performanceSteps)
    assert.equal(snapshot.myPerformanceSteps.length, 2)
    if (cardsByRole[snapshot.myRole]) assert.equal(snapshot.myWord, cardsByRole[snapshot.myRole])
    cardsByRole[snapshot.myRole] = snapshot.myWord
  }
  assert.notEqual(cardsByRole.spy, cardsByRole.civilian)
  const original = manager.getReconnectGameSnapshot(room.id, playerIds[1])
  manager.markDisconnected('socket-1')
  const reconnected = manager.registerConnection({ playerId: playerIds[1], identityKey: 'identity-1', socketId: 'new-1' })
  assert.equal(reconnected.reconnectEvent.payload.myWord, original.myWord)
  assert.deepEqual(reconnected.reconnectEvent.payload.myPerformanceSteps, original.myPerformanceSteps)
  const left = manager.leaveRoom(room.id, playerIds[1])
  assert.equal(left.gameAction.type, 'stateSync')
  assert.equal(room.gameState.phase, 'dealing')
  assert.equal(room.status, 'playing')
  assert.equal(manager.getReconnectGameSnapshot(room.id, playerIds[1]), null)
  assert.equal(room.gameState.playerPerformanceSteps[playerIds[1]], undefined)
  manager.restartGame(hostId)
  assert.equal(room.playMode, 'body')
  assert.equal(room.gameState, null)
  assert.equal(manager.getSyncState(hostId).game, null)
  assert.equal(room.usedPromptPairIds.body.length, 1)
  manager.startGame(hostId, 'body')
  const replacement = manager.createRoom({ playerId: hostId })
  assert.equal(replacement.room.playMode, 'language')
  assert.equal(replacement.previousRoomResult.reason, 'switch_room')
  assert.equal(replacement.room.gameState, null)
})

test('24 complete pairs in four categories, variants and strict schema', () => {
  const source = loadWordCategories(path.join(__dirname, '../src/data/body-prompts'))
  const library = new BodyPromptLibrary(source)
  assert.equal(library.size, 24)
  assert.equal(library.categories.length, 4)
  assert.ok(library.categories.every((category) => category.size === 6))
  const mutations = [
    (data) => { data.categories[0].playMode = 'language' },
    (data) => { data.categories[0].groups[0].id = '' },
    (data) => { data.categories[0].groups[0].variants.pop() },
    (data) => { data.categories[0].groups[0].variants[0].text = '' },
    (data) => { data.categories[0].groups[0].variants[0].performanceSteps = ['不一致', '反应'] },
    (data) => { data.categories[0].groups[0].variants[0].performanceSteps.push('多余') },
    (data) => { data.categories[0].groups[0].variants[1].id = 'a' },
    (data) => { data.categories[0].groups[1].id = data.categories[0].groups[0].id },
    (data) => {
      data.categories[0].groups[1].sharedAction = data.categories[0].groups[0].sharedAction
      data.categories[0].groups[1].variants = data.categories[0].groups[0].variants.slice().reverse()
    },
    (data) => { data.categories[1].id = data.categories[0].id },
  ]
  for (const mutate of mutations) {
    const data = structuredClone(source)
    mutate(data)
    assert.throws(() => new BodyPromptLibrary(data))
  }
  const random = Math.random
  try {
    Math.random = () => 0
    const first = library.getRandomPair()
    assert.equal(first.civilian, source.categories[0].groups[0].variants[0].text)
    assert.deepEqual(first.civilianSteps, source.categories[0].groups[0].variants[0].performanceSteps)
    Math.random = () => 0.99
    const swapped = library.getRandomPair({ categories: [first.categoryId] })
    const group = library.wordGroups.find((item) => item.groupId === swapped.groupId)
    assert.equal(swapped.civilian, group.variants[1].text)
    assert.deepEqual(swapped.civilianSteps, group.variants[1].performanceSteps)
  } finally { Math.random = random }
  assert.throws(() => library.getRandomPair({ categories: ['missing'] }))
  assert.throws(() => new BodyPromptLibrary({ categories: [] }))
})

test('stable history is independent per mode and resets only the exhausted mode', (context) => {
  const { manager, room, hostId } = fixture(context)
  manager.startGame(hostId, 'language')
  const languageHistory = [...room.usedPromptPairIds.language]
  manager.restartGame(hostId)
  manager.setPlayMode(hostId, 'body')
  for (let index = 0; index < 24; index += 1) {
    manager.startGame(hostId, 'body')
    assert.equal(new Set(room.usedPromptPairIds.body).size, index + 1)
    manager.restartGame(hostId)
  }
  manager.startGame(hostId, 'body')
  assert.equal(room.usedPromptPairIds.body.length, 1)
  assert.deepEqual(room.usedPromptPairIds.language, languageHistory)
  manager.restartGame(hostId)
  manager.setPlayMode(hostId, 'language')
  manager.wordLibrary = new WordLibrary([{ civilian: '甲', spy: '乙' }])
  manager.startGame(hostId, 'language')
  manager.restartGame(hostId)
  const bodyHistory = [...room.usedPromptPairIds.body]
  manager.startGame(hostId, 'language')
  assert.equal(room.usedPromptPairIds.language.length, 1)
  assert.deepEqual(room.usedPromptPairIds.body, bodyHistory)
})

test('empty, missing or malformed body draws do not commit state or history or fall back', (context) => {
  const { manager, room, hostId } = fixture(context)
  manager.setPlayMode(hostId, 'body')
  manager.wordLibrary = { getRandomPair() { assert.fail('must not use language library') } }
  for (const library of [null, new BodyPromptLibrary(), { getRandomPair() { throw new Error('draw failed') } },
    { getRandomPair() { return { civilian: '甲', spy: '乙' } } }]) {
    if (library instanceof BodyPromptLibrary) library.wordGroups = []
    manager.bodyPromptLibrary = library
    const before = structuredClone(room.usedPromptPairIds)
    assert.throws(() => manager.startGame(hostId, 'body'))
    assert.equal(room.status, 'waiting')
    assert.equal(room.gameState, null)
    assert.deepEqual(room.usedPromptPairIds, before)
  }
})
