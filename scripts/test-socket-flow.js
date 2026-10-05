const assert = require('node:assert/strict')
const { createFixture, request } = require('./auth-fixture')
const BodyPromptLibrary = require('../src/data/BodyPromptLibrary')
const EVENTS = require('../src/socket/events')
const { publishLeaveResult } = require('../src/socket/emitPatterns')

function waitForEvent(socket, eventName, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler)
      reject(new Error('Timed out waiting for ' + eventName))
    }, 2000)
    const handler = (payload) => {
      if (!matches(payload)) return
      clearTimeout(timer)
      socket.off(eventName, handler)
      resolve(payload)
    }
    socket.on(eventName, handler)
  })
}

function testLeavePublisherOrder() {
  const events = []
  const io = { to: () => ({ emit: (event) => events.push(event) }) }
  const socket = { leave: () => events.push('socket:leave'), emit: (event) => events.push(event) }
  publishLeaveResult(io, socket, (roomId) => 'room:' + roomId, {
    roomId: 'room-1', roomState: { roomId: 'room-1' }, removedPlayer: { id: 'player-1' },
    hostChanged: { id: 'player-2' }, reason: 'leave',
    gameAction: { type: 'stateSync', payload: { phase: 'dealing' } },
  }, { notifyLeaver: true })
  assert.deepEqual(events, [
    'socket:leave', EVENTS.server.ROOM_LEFT, EVENTS.server.ROOM_PLAYER_LEFT,
    EVENTS.server.ROOM_STATE, EVENTS.server.ROOM_HOST_CHANGED, EVENTS.server.GAME_STATE_SYNC,
  ])
}

async function main() {
  testLeavePublisherOrder()
  const fixture = await createFixture()
  fixture.manager.bodyPromptLibrary = new BodyPromptLibrary()
  try {
    const accounts = await Promise.all(Array.from({ length: 6 }, (_, index) => fixture.login('flow-' + index)))
    const clients = []
    for (const account of accounts) clients.push(await fixture.connect({ token: account.token }))
    let host = clients[0]
    const first = await request(host.socket, 'room:create')
    assert.equal(first.room.playMode, 'language')
    const oldRoomId = first.room.roomId
    await request(clients[1].socket, 'room:join', { roomId: oldRoomId })
    const oldDisconnected = waitForEvent(host.socket, 'disconnect')
    host = await fixture.connect({ token: accounts[0].token, playerId: host.playerId })
    await oldDisconnected
    assert.equal(host.playerId, clients[0].playerId)
    const order = []
    for (const event of ['room:playerLeft', 'room:state', 'room:hostChanged']) {
      clients[1].socket.on(event, (payload) => {
        if (payload.room?.roomId === oldRoomId && (event === 'room:playerLeft' || order.length)) order.push(event)
      })
    }
    const changed = waitForEvent(clients[1].socket, 'room:hostChanged')
    const created = await request(host.socket, 'room:create')
    await changed
    assert.deepEqual(order, ['room:playerLeft', 'room:state', 'room:hostChanged'])
    const roomId = created.room.roomId
    for (const client of clients.slice(1, 4)) {
      assert.equal((await request(client.socket, 'room:join', { roomId })).ok, true)
    }
    const publicPayloads = []
    clients[1].socket.on('room:state', (payload) => publicPayloads.push(payload))
    clients[1].socket.on('game:stateSync', (payload) => publicPayloads.push(payload))
    assert.equal((await request(clients[1].socket, 'room:setPlayMode', { playMode: 'body' })).error.code, 'HOST_ONLY_ACTION')
    const modeBroadcast = waitForEvent(clients[1].socket, 'room:state', (payload) => payload.room.playMode === 'body')
    const mode = await request(host.socket, 'room:setPlayMode', { playMode: 'body' })
    assert.equal(mode.room.maxPlayers, 5)
    assert.equal(mode.room.minStartPlayers, 3)
    assert.equal(mode.room.spyCount, 1)
    assert.deepEqual((await modeBroadcast).room, mode.room)
    assert.equal((await request(host.socket, 'room:setPlayMode', { playMode: 'body' })).ok, true)
    assert.equal((await request(host.socket, 'room:setSpyCount', { spyCount: 2 })).error.code, 'INVALID_SPY_COUNT')
    const refreshed = waitForEvent(host.socket, 'room:state')
    const staleStart = await request(host.socket, 'room:startGame', { playMode: 'language' })
    assert.equal(staleStart.error.code, 'PLAY_MODE_MISMATCH')
    assert.equal((await refreshed).room.playMode, 'body')
    assert.equal(fixture.manager.getRoomState(roomId).status, 'waiting')
    await request(clients[4].socket, 'room:join', { roomId })
    assert.equal((await request(clients[5].socket, 'room:join', { roomId })).error.code, 'ROOM_FULL')
    const participants = [host, ...clients.slice(1, 5)]
    const cards = participants.map((client) => waitForEvent(client.socket, 'game:started'))
    assert.equal((await request(host.socket, 'room:startGame', { playMode: 'body' })).ok, true)
    const snapshots = await Promise.all(cards)
    assert.equal(snapshots.filter((card) => card.myRole === 'spy').length, 1)
    assert.ok(snapshots.every((card) => card.playMode === 'body' && card.myPerformanceSteps.length === 2))
    assert.equal((await request(host.socket, 'room:setPlayMode', { playMode: 'language' })).error.code, 'GAME_ALREADY_STARTED')
    for (const event of ['game:confirmWord', 'game:startVote', 'game:vote', 'game:continue']) {
      assert.equal(fixture.io.sockets.sockets.get(host.socket.id).listenerCount(event), 0)
    }
    const member = participants[2]
    const original = snapshots[2]
    const sync = await request(member.socket, 'room:syncState')
    assert.equal(sync.game.myWord, original.myWord)
    assert.deepEqual(sync.game.myPerformanceSteps, original.myPerformanceSteps)
    const originalDisconnected = waitForEvent(member.socket, 'disconnect')
    const replacement = await fixture.connect({ token: accounts[2].token, playerId: member.playerId })
    await originalDisconnected
    const restored = await request(replacement.socket, 'room:syncState')
    assert.equal(restored.game.myWord, original.myWord)
    assert.deepEqual(restored.game.myPerformanceSteps, original.myPerformanceSteps)
    assert.equal((await request(replacement.socket, 'game:restart')).error.code, 'HOST_ONLY_ACTION')
    const stateAfterLeave = waitForEvent(clients[1].socket, 'game:stateSync')
    await request(replacement.socket, 'room:leave')
    assert.equal((await stateAfterLeave).phase, 'dealing')
    assert.equal(fixture.manager.getRoomState(roomId).status, 'playing')
    assert.equal(fixture.manager.getReconnectGameSnapshot(roomId, member.playerId), null)
    const restartEvent = waitForEvent(clients[1].socket, 'game:restarted')
    const restarted = await request(host.socket, 'game:restart')
    assert.equal(restarted.room.status, 'waiting')
    assert.equal(restarted.room.playMode, 'body')
    assert.equal((await restartEvent).room.playMode, 'body')
    assert.equal((await request(host.socket, 'room:syncState')).game, null)
    await request(host.socket, 'room:setPlayMode', { playMode: 'language' })
    const languageCard = waitForEvent(host.socket, 'game:started')
    await request(host.socket, 'room:startGame', { playMode: 'language' })
    assert.equal((await languageCard).myPerformanceSteps, null)
    for (const payload of publicPayloads) {
      const serialized = JSON.stringify(payload)
      for (const secret of ['myWord', 'myRole', 'myPerformanceSteps', 'playerWords', 'playerPerformanceSteps', 'wordPair', 'promptPairKey']) {
        assert.equal(serialized.includes('"' + secret + '"'), false)
      }
    }
    await request(host.socket, 'game:restart')
    await request(replacement.socket, 'room:join', { roomId })
    await request(clients[5].socket, 'room:join', { roomId })
    const before = fixture.manager.getRoomState(roomId)
    const rejected = await request(host.socket, 'room:setPlayMode', { playMode: 'body' })
    assert.equal(rejected.error.code, 'ROOM_OVER_CAPACITY')
    assert.deepEqual(fixture.manager.getRoomState(roomId), before)
    console.log('Real authenticated socket flow passed for language and body.')
  } finally { await fixture.close() }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
