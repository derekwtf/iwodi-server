const assert = require('assert')
const http = require('http')
const { Server } = require('socket.io')
const { io: connectClient } = require('socket.io-client')
const RoomManager = require('../src/room/RoomManager')
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
  })
  const server = http.createServer()
  const io = new Server(server)
  initializeSocketServer(io, manager)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const clients = []

  async function connect(playerId = null, followupEvent = null) {
    const socket = connectClient(url, {
      autoConnect: false,
      transports: ['websocket'],
      auth: playerId ? { playerId } : {},
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
    await request(dealHost.socket, EVENTS.client.ROOM_START_GAME)
    const dealSnapshot = manager.getReconnectGameSnapshot(dealRoom.room.roomId, dealPlayers[1].playerId)
    assert.strictEqual(dealSnapshot.gameMode, 'deal-only')
    assert.strictEqual(dealSnapshot.phase, 'dealing')
    assert.ok(dealSnapshot.myWord)
    assert.throws(
      () => manager.confirmWord(dealPlayers[1].playerId),
      (error) => error.code === 'GAME_CONFIRM_DISABLED'
    )
    dealPlayers[1].socket.close()
    const reconnectedDealPlayer = await connect(
      dealPlayers[1].playerId, EVENTS.server.RECONNECT_GAME_SNAPSHOT
    )
    assert.strictEqual(reconnectedDealPlayer.playerId, dealPlayers[1].playerId)
    assert.strictEqual((await reconnectedDealPlayer.followup).myWord, dealSnapshot.myWord)
    const restarted = await request(dealHost.socket, EVENTS.client.GAME_RESTART)
    assert.strictEqual(restarted.room.status, 'waiting')

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
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
