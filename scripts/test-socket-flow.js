const assert = require('assert')
const http = require('http')
const { Server } = require('socket.io')
const { io: connectClient } = require('socket.io-client')
const RoomManager = require('../src/room/RoomManager')
const UserStore = require('../src/user/UserStore')
const { createTokenService } = require('../src/auth/tokens')
const EVENTS = require('../src/socket/events')
const { initializeSocketServer } = require('../src/socket')
const { publishLeaveResult } = require('../src/socket/emitPatterns')

function waitForEvent(socket, eventName, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler)
      reject(new Error(`Timed out waiting for ${eventName}`))
    }, timeoutMs)
    const handler = (payload) => {
      clearTimeout(timer)
      socket.off(eventName, handler)
      resolve(payload)
    }
    socket.on(eventName, handler)
  })
}

function request(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(2000).emit(eventName, payload, (error, response) => {
      if (error) return reject(error)
      if (!response.ok) return reject(new Error(`${eventName}: ${response.error.message}`))
      resolve(response)
    })
  })
}

function testLeavePublisherOrderAndTimerCleanup() {
  const events = []
  const io = { to: () => ({ emit: (event) => events.push(event) }) }
  const socket = {
    leave: () => events.push('socket:leave'),
    emit: (event) => events.push(event),
  }
  const voteTimerStore = new Map()
  const reminderTimer = setTimeout(() => { throw new Error('reminder timer was not cleared') }, 100)
  const timeoutTimer = setTimeout(() => { throw new Error('vote timer was not cleared') }, 100)
  voteTimerStore.set('room-1', { reminderTimer, timeoutTimer })

  publishLeaveResult(io, socket, (id) => `room:${id}`, {
    roomId: 'room-1',
    roomState: { roomId: 'room-1' },
    removedPlayer: { id: 'player-1' },
    hostChanged: { id: 'player-2' },
    reason: 'leave',
    gameAction: { type: 'result', payload: { phase: 'result' } },
  }, voteTimerStore, { notifyLeaver: true })

  assert.deepStrictEqual(events, [
    'socket:leave', EVENTS.server.ROOM_LEFT, EVENTS.server.ROOM_PLAYER_LEFT,
    EVENTS.server.ROOM_STATE, EVENTS.server.ROOM_HOST_CHANGED, EVENTS.server.GAME_RESULT,
  ])
  assert.strictEqual(voteTimerStore.has('room-1'), false)
}

async function main() {
  testLeavePublisherOrderAndTimerCleanup()
  const manager = new RoomManager({
    wordLibrary: {
      getRandomPair: () => ({
        index: 1, groupId: 'test', categoryId: 'test', categoryLabel: '测试',
        candidateWords: ['甲', '乙'], civilian: '甲', spy: '乙',
      }),
    },
    voteReminderMs: 500,
    voteTimeoutMs: 1500,
    minStartPlayers: 2,
  })
  const server = http.createServer()
  const io = new Server(server)
  const userStore = new UserStore(':memory:')
  const tokens = createTokenService('test-secret-'.repeat(4))
  initializeSocketServer(io, manager, { userStore, tokens })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const clients = []

  async function connect(playerId = null, followupEvent = null) {
    const userId = playerId
      ? manager.sessionRegistry.get(playerId).identityKey
      : userStore.findOrCreate({ provider: 'test', scope: 'flow', subject: `user-${clients.length}` }).userId
    const socket = connectClient(url, {
      autoConnect: false,
      transports: ['websocket'],
      auth: { playerId, token: tokens.issue(userId).token },
    })
    clients.push(socket)
    const connected = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
    const followup = followupEvent ? waitForEvent(socket, followupEvent) : null
    socket.connect()
    const payload = await connected
    return { socket, playerId: payload.playerId, followup }
  }

  try {
    const first = await connect()
    const initialRoom = await request(first.socket, EVENTS.client.ROOM_CREATE, {
      nickname: '房主', gameMode: 'full',
    })
    const oldDisconnected = waitForEvent(first.socket, 'disconnect')
    const replacement = await connect(first.playerId, EVENTS.server.RECONNECT_ROOM_STATE)
    await oldDisconnected
    assert.strictEqual((await replacement.followup).roomId, initialRoom.room.roomId)
    assert.strictEqual(replacement.playerId, first.playerId)
    assert.strictEqual(manager.getActiveSocketId(first.playerId), manager.sessionRegistry.get(first.playerId).socketId)
    assert.strictEqual(manager.getRoomState(initialRoom.room.roomId).players[0].disconnected, false)

    const witness = await connect()
    await request(witness.socket, EVENTS.client.ROOM_JOIN, {
      roomId: initialRoom.room.roomId, nickname: '见证者',
    })
    const broadcastOrder = []
    for (const event of [EVENTS.server.ROOM_PLAYER_LEFT, EVENTS.server.ROOM_STATE, EVENTS.server.ROOM_HOST_CHANGED]) {
      witness.socket.on(event, (payload) => {
        if (payload.room?.roomId === initialRoom.room.roomId) broadcastOrder.push(event)
      })
    }
    const hostChanged = waitForEvent(witness.socket, EVENTS.server.ROOM_HOST_CHANGED)
    await request(replacement.socket, EVENTS.client.ROOM_CREATE, { nickname: '新房主' })
    await hostChanged
    assert.deepStrictEqual(broadcastOrder, [
      EVENTS.server.ROOM_PLAYER_LEFT, EVENTS.server.ROOM_STATE, EVENTS.server.ROOM_HOST_CHANGED,
    ])
    assert.strictEqual(manager.getRoomState(initialRoom.room.roomId).players[0].id, witness.playerId)

    const host = await connect()
    const gameRoom = await request(host.socket, EVENTS.client.ROOM_CREATE, { nickname: '游戏房主' })
    const players = [host]
    for (let i = 1; i < 4; i += 1) {
      const player = await connect()
      await request(player.socket, EVENTS.client.ROOM_JOIN, {
        roomId: gameRoom.room.roomId, nickname: `玩家${i}`,
      })
      players.push(player)
    }
    manager.startGame(host.playerId)
    players.forEach((player) => manager.confirmWord(player.playerId))
    await request(host.socket, EVENTS.client.GAME_START_VOTE)
    const gameState = manager.rooms.get(gameRoom.room.roomId).gameState
    const leavingPlayer = players.find((player) => gameState.roles[player.playerId] === 'civilian')
    const remaining = players.filter((player) => player !== leavingPlayer)
    for (const player of remaining) {
      await request(player.socket, EVENTS.client.GAME_VOTE, { targetId: null })
    }
    const resultEvent = waitForEvent(remaining[0].socket, EVENTS.server.GAME_RESULT)
    const leaveAck = await request(leavingPlayer.socket, EVENTS.client.RECONNECT_ABANDON)
    const result = await resultEvent
    assert.strictEqual(leaveAck.roomId, gameRoom.room.roomId)
    assert.strictEqual(result.phase, 'result')
    assert.strictEqual(manager.rooms.get(gameRoom.room.roomId).gameState.phase, 'result')

    const dealHost = await connect()
    const dealRoom = await request(dealHost.socket, EVENTS.client.ROOM_CREATE, {
      nickname: '仅发牌房主', gameMode: 'deal-only',
    })
    const dealPlayers = [dealHost]
    for (let i = 1; i < 4; i += 1) {
      const player = await connect()
      await request(player.socket, EVENTS.client.ROOM_JOIN, {
        roomId: dealRoom.room.roomId, nickname: `发牌玩家${i}`,
      })
      dealPlayers.push(player)
    }
    const dealStartedEvent = waitForEvent(dealPlayers[1].socket, EVENTS.server.GAME_STARTED)
    await request(dealHost.socket, EVENTS.client.ROOM_START_GAME)
    const dealSnapshot = await dealStartedEvent
    assert.strictEqual(dealSnapshot.gameMode, 'deal-only')
    assert.strictEqual(dealSnapshot.phase, 'dealing')
    assert.ok(dealSnapshot.myWord)
    assert.ok(dealSnapshot.myRole)
    assert.throws(
      () => manager.confirmWord(dealPlayers[1].playerId),
      (error) => error.code === 'GAME_CONFIRM_DISABLED'
    )
    const dealDisconnectedEvent = waitForEvent(dealHost.socket, EVENTS.server.ROOM_PLAYER_DISCONNECTED)
    dealPlayers[1].socket.close()
    await dealDisconnectedEvent
    const dealSyncEvent = waitForEvent(dealHost.socket, EVENTS.server.GAME_STATE_SYNC)
    const reconnectedDealPlayer = await connect(
      dealPlayers[1].playerId, EVENTS.server.RECONNECT_GAME_SNAPSHOT
    )
    assert.strictEqual(reconnectedDealPlayer.playerId, dealPlayers[1].playerId)
    const reconnectedDealSnapshot = await reconnectedDealPlayer.followup
    assert.strictEqual(reconnectedDealSnapshot.myWord, dealSnapshot.myWord)
    assert.strictEqual(reconnectedDealSnapshot.myRole, dealSnapshot.myRole)
    const dealSync = await dealSyncEvent
    assert.strictEqual(dealSync.roomId, dealRoom.room.roomId)
    assert.strictEqual(dealSync.gameMode, 'deal-only')
    assert.strictEqual(dealSync.phase, 'dealing')
    for (const secret of ['roles', 'wordPair', 'playerWords', 'myRole', 'myWord']) {
      assert.strictEqual(Object.hasOwn(dealSync, secret), false, `deal-only reconnect leaked ${secret}`)
    }
    const restarted = await request(dealHost.socket, EVENTS.client.GAME_RESTART)
    assert.strictEqual(restarted.room.status, 'waiting')

    const fullHost = await connect()
    const fullRoom = await request(fullHost.socket, EVENTS.client.ROOM_CREATE, {
      nickname: '全流程重连房主', gameMode: 'full',
    })
    const fullPlayers = [fullHost]
    for (let i = 1; i < 4; i += 1) {
      const player = await connect()
      await request(player.socket, EVENTS.client.ROOM_JOIN, {
        roomId: fullRoom.room.roomId, nickname: `全流程玩家${i}`,
      })
      fullPlayers.push(player)
    }
    const fullStartedEvents = fullPlayers.map((player) => waitForEvent(player.socket, EVENTS.server.GAME_STARTED))
    await request(fullHost.socket, EVENTS.client.ROOM_START_GAME)
    const fullSnapshots = await Promise.all(fullStartedEvents)
    assert.ok(fullSnapshots[1].myWord)
    assert.ok(fullSnapshots[1].myRole)
    const fullDisconnectedEvent = waitForEvent(fullHost.socket, EVENTS.server.ROOM_PLAYER_DISCONNECTED)
    fullPlayers[1].socket.close()
    await fullDisconnectedEvent
    const fullSyncEvent = waitForEvent(fullHost.socket, EVENTS.server.GAME_STATE_SYNC)
    fullPlayers[1] = await connect(fullPlayers[1].playerId, EVENTS.server.RECONNECT_GAME_SNAPSHOT)
    const fullReconnectSnapshot = await fullPlayers[1].followup
    assert.strictEqual(fullReconnectSnapshot.myWord, fullSnapshots[1].myWord)
    assert.strictEqual(fullReconnectSnapshot.myRole, fullSnapshots[1].myRole)
    const fullSync = await fullSyncEvent
    assert.strictEqual(fullSync.roomId, fullRoom.room.roomId)
    assert.strictEqual(fullSync.gameMode, 'full')
    assert.strictEqual(fullSync.phase, 'dealing')
    for (const secret of ['roles', 'wordPair', 'playerWords', 'myRole', 'myWord']) {
      assert.strictEqual(Object.hasOwn(fullSync, secret), false, `full reconnect leaked ${secret}`)
    }

    for (const player of fullPlayers) {
      await request(player.socket, EVENTS.client.GAME_CONFIRM_WORD)
    }
    const spy = fullPlayers[fullSnapshots.findIndex((snapshot) => snapshot.myRole === 'spy')]
    assert.ok(spy)
    await request(fullHost.socket, EVENTS.client.GAME_START_VOTE)
    const fullResultEvent = waitForEvent(fullHost.socket, EVENTS.server.GAME_RESULT)
    for (const player of fullPlayers) {
      await request(player.socket, EVENTS.client.GAME_VOTE, {
        targetId: player === spy ? null : spy.playerId,
      })
    }
    assert.strictEqual((await fullResultEvent).phase, 'ended')
    const endedEvent = waitForEvent(fullHost.socket, EVENTS.server.GAME_ENDED)
    await request(fullHost.socket, EVENTS.client.GAME_CONTINUE)
    const ended = await endedEvent
    assert.strictEqual(ended.finalResult.winner, 'civilian')
    assert.strictEqual(Object.keys(ended.roles).length, 4)
    assert.ok(ended.wordPair.civilian)
    assert.ok(ended.wordPair.spy)

    const endedDisconnectedEvent = waitForEvent(fullHost.socket, EVENTS.server.ROOM_PLAYER_DISCONNECTED)
    fullPlayers[1].socket.close()
    await endedDisconnectedEvent
    const endedSyncEvent = waitForEvent(fullHost.socket, EVENTS.server.GAME_STATE_SYNC)
    const endedPlayer = await connect(fullPlayers[1].playerId, EVENTS.server.RECONNECT_GAME_SNAPSHOT)
    const endedSnapshot = await endedPlayer.followup
    assert.strictEqual(endedSnapshot.myWord, fullSnapshots[1].myWord)
    assert.strictEqual(endedSnapshot.myRole, fullSnapshots[1].myRole)
    const endedSync = await endedSyncEvent
    assert.strictEqual(endedSync.roomId, fullRoom.room.roomId)
    assert.strictEqual(endedSync.phase, 'ended')
    assert.deepStrictEqual(endedSync.roles, ended.roles, 'ended reconnect must retain revealed roles')
    assert.deepStrictEqual(endedSync.wordPair, ended.wordPair, 'ended reconnect must retain revealed words')
    assert.deepStrictEqual(endedSync.finalResult, ended.finalResult)
    for (const secret of ['playerWords', 'myRole', 'myWord']) {
      assert.strictEqual(Object.hasOwn(endedSync, secret), false, `ended reconnect leaked ${secret}`)
    }

    const leavingHost = await connect()
    const leaveRoom = await request(leavingHost.socket, EVENTS.client.ROOM_CREATE, {
      nickname: '离房房主', gameMode: 'deal-only',
    })
    const remainingPlayer = await connect()
    await request(remainingPlayer.socket, EVENTS.client.ROOM_JOIN, {
      roomId: leaveRoom.room.roomId, nickname: '接任房主',
    })
    const startedRoomState = waitForEvent(remainingPlayer.socket, EVENTS.server.ROOM_STATE)
    await request(leavingHost.socket, EVENTS.client.ROOM_START_GAME)
    await startedRoomState
    const leaveEvents = []
    for (const event of [
      EVENTS.server.ROOM_PLAYER_LEFT,
      EVENTS.server.ROOM_STATE,
      EVENTS.server.ROOM_HOST_CHANGED,
      EVENTS.server.GAME_STATE_SYNC,
    ]) {
      remainingPlayer.socket.on(event, (payload) => {
        const roomId = payload.room?.roomId || payload.roomId
        if (roomId === leaveRoom.room.roomId) leaveEvents.push(event)
      })
    }
    const stateSyncEvent = waitForEvent(remainingPlayer.socket, EVENTS.server.GAME_STATE_SYNC)
    await request(leavingHost.socket, EVENTS.client.ROOM_LEAVE)
    const stateSync = await stateSyncEvent
    assert.deepStrictEqual(leaveEvents, [
      EVENTS.server.ROOM_PLAYER_LEFT,
      EVENTS.server.ROOM_STATE,
      EVENTS.server.ROOM_HOST_CHANGED,
      EVENTS.server.GAME_STATE_SYNC,
    ])
    assert.strictEqual(stateSync.phase, 'dealing')
    assert.strictEqual(manager.getRoomState(leaveRoom.room.roomId).status, 'playing')
    assert.strictEqual(manager.getRoomState(leaveRoom.room.roomId).players[0].id, remainingPlayer.playerId)
    for (const secret of ['roles', 'wordPair', 'playerWords', 'myRole', 'myWord']) {
      assert.strictEqual(Object.hasOwn(stateSync, secret), false)
    }
    const newcomer = await connect()
    await assert.rejects(
      request(newcomer.socket, EVENTS.client.ROOM_JOIN, {
        roomId: leaveRoom.room.roomId, nickname: '新玩家',
      }),
      /游戏已开始，无法加入/
    )
    const reopened = await request(remainingPlayer.socket, EVENTS.client.GAME_RESTART)
    assert.strictEqual(reopened.room.status, 'waiting')
    const joined = await request(newcomer.socket, EVENTS.client.ROOM_JOIN, {
      roomId: leaveRoom.room.roomId, nickname: '新玩家',
    })
    assert.strictEqual(joined.room.status, 'waiting')

    const timeoutHost = await connect()
    const timeoutRoom = await request(timeoutHost.socket, EVENTS.client.ROOM_CREATE, {
      nickname: '超时房主', gameMode: 'full',
    })
    const timeoutPlayers = [timeoutHost]
    for (let i = 1; i < 4; i += 1) {
      const player = await connect()
      await request(player.socket, EVENTS.client.ROOM_JOIN, {
        roomId: timeoutRoom.room.roomId, nickname: `超时玩家${i}`,
      })
      timeoutPlayers.push(player)
    }
    await request(timeoutHost.socket, EVENTS.client.ROOM_START_GAME)
    for (const player of timeoutPlayers) {
      await request(player.socket, EVENTS.client.GAME_CONFIRM_WORD)
    }
    const reminderEvent = waitForEvent(timeoutHost.socket, EVENTS.server.GAME_VOTE_REMINDER)
    const timeoutResultEvent = waitForEvent(timeoutHost.socket, EVENTS.server.GAME_RESULT, 4000)
    await request(timeoutHost.socket, EVENTS.client.GAME_START_VOTE)
    const reminder = await reminderEvent
    assert.strictEqual(reminder.roomId, timeoutRoom.room.roomId)
    assert.deepStrictEqual(
      reminder.pendingPlayerIds.slice().sort(),
      timeoutPlayers.map((player) => player.playerId).sort()
    )
    const timeoutResult = await timeoutResultEvent
    assert.strictEqual(timeoutResult.phase, 'result')
    assert.strictEqual(timeoutResult.currentResult.eliminated, null)
    assert.deepStrictEqual(Object.values(timeoutResult.currentResult.votes), [null, null, null, null])

    console.log('Socket flow test passed.')
  } finally {
    clients.forEach((socket) => socket.close())
    await new Promise((resolve) => io.close(resolve))
    userStore.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
