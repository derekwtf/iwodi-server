/* eslint-disable no-console */
const assert = require('assert')
const { io } = require('socket.io-client')
const EVENTS = require('../src/socket/events')

const SERVER_URL = process.env.SMOKE_SERVER_URL || 'http://127.0.0.1:3010'

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handleEvent)
      reject(new Error(`等待事件超时: ${eventName}`))
    }, timeoutMs)

    const handleEvent = (payload) => {
      clearTimeout(timer)
      socket.off(eventName, handleEvent)
      resolve(payload)
    }

    socket.on(eventName, handleEvent)
  })
}

function emitWithAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(eventName, payload, (response) => {
      if (!response || !response.ok) {
        reject(new Error(`${eventName} 失败: ${JSON.stringify(response)}`))
        return
      }

      resolve(response)
    })
  })
}

async function connectClient(existingPlayerId) {
  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: existingPlayerId ? { playerId: existingPlayerId } : {},
  })

  const connectPromise = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
  socket.connect()
  const connectPayload = await connectPromise

  return {
    socket,
    playerId: connectPayload.playerId,
  }
}

async function waitForAll(clients, eventName, trigger) {
  const promises = clients.map((client) => waitForEvent(client.socket, eventName))
  await trigger()
  return Promise.all(promises)
}

function groupPlayersByWord(gameSnapshots, clients) {
  const groups = new Map()
  gameSnapshots.forEach((snapshot, index) => {
    const word = snapshot.myWord
    if (!groups.has(word)) {
      groups.set(word, [])
    }
    groups.get(word).push(clients[index])
  })

  return Array.from(groups.values()).sort((left, right) => right.length - left.length)
}

async function joinRoom(host, guests) {
  const createResult = await emitWithAck(host.socket, EVENTS.client.ROOM_CREATE, {
    nickname: '房主',
    avatar: 'host-avatar',
  })
  const roomId = createResult.room.roomId

  for (const guest of guests) {
    await emitWithAck(guest.socket, EVENTS.client.ROOM_JOIN, {
      roomId,
      nickname: guest.nickname,
      avatar: guest.avatar,
    })
  }

  return roomId
}

async function readyPlayers(players) {
  for (const player of players) {
    await emitWithAck(player.socket, EVENTS.client.ROOM_READY, {
      isReady: true,
    })
  }
}

async function startGame(host, roomPlayers) {
  const started = roomPlayers.map((player) =>
    waitForEvent(player.socket, EVENTS.server.GAME_STARTED)
  )
  await emitWithAck(host.socket, EVENTS.client.ROOM_START_GAME, {})
  return Promise.all(started)
}

async function confirmAllWords(players) {
  return waitForAll(players, EVENTS.server.GAME_SPEAKING_STARTED, async () => {
    for (const player of players) {
      await emitWithAck(player.socket, EVENTS.client.GAME_CONFIRM_WORD, {})
    }
  })
}

async function startVote(host, players) {
  return waitForAll(players, EVENTS.server.GAME_VOTE_STARTED, async () => {
    await emitWithAck(host.socket, EVENTS.client.GAME_START_VOTE, {})
  })
}

async function continueGame(host, players, targetEvent) {
  return waitForAll(players, targetEvent, async () => {
    await emitWithAck(host.socket, EVENTS.client.GAME_CONTINUE, {})
  })
}

async function scenarioCivilianWin(host, players, extraPlayer) {
  const roomId = await joinRoom(host, players.slice(1))
  assert.match(roomId, /^\d{6}$/)

  await readyPlayers(players.slice(1))
  const startedSnapshots = await startGame(host, players)
  const groupedPlayers = groupPlayersByWord(startedSnapshots, players)

  assert.strictEqual(groupedPlayers.length, 2)
  assert.deepStrictEqual(
    groupedPlayers.map((group) => group.length).sort((left, right) => left - right),
    [1, 3]
  )

  const spyPlayer = groupedPlayers.find((group) => group.length === 1)[0]
  const civilianPlayers = players.filter((player) => player.playerId !== spyPlayer.playerId)

  await confirmAllWords(players)
  await startVote(host, players)

  const resultSnapshotsPromise = players.map((player) =>
    waitForEvent(player.socket, EVENTS.server.GAME_RESULT)
  )
  for (const civilianPlayer of civilianPlayers) {
    await emitWithAck(civilianPlayer.socket, EVENTS.client.GAME_VOTE, {
      targetId: spyPlayer.playerId,
    })
  }
  await emitWithAck(spyPlayer.socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[0].playerId,
  })

  const resultSnapshots = await Promise.all(resultSnapshotsPromise)
  resultSnapshots.forEach((snapshot) => {
    assert.strictEqual(snapshot.phase, 'ended')
    assert.strictEqual(snapshot.currentResult.eliminated, spyPlayer.playerId)
    assert.strictEqual(snapshot.finalResult.winner, 'civilian')
    assert.strictEqual(snapshot.roundHistory.length, 1)
  })

  const endedSnapshots = await continueGame(host, players, EVENTS.server.GAME_ENDED)
  endedSnapshots.forEach((snapshot) => {
    assert.strictEqual(snapshot.finalResult.winner, 'civilian')
    assert.ok(snapshot.roles)
    assert.ok(snapshot.wordPair)
    assert.strictEqual(snapshot.roundHistory.length, 1)
  })

  const restartReadyPlayer = civilianPlayers.find(
    (player) => player.playerId !== host.playerId
  )
  const restartReadyEvent = waitForEvent(
    host.socket,
    EVENTS.server.GAME_PLAYER_RESTART_READY
  )
  await emitWithAck(restartReadyPlayer.socket, EVENTS.client.GAME_RESTART_READY, {})
  const restartReadyPayload = await restartReadyEvent
  assert.strictEqual(restartReadyPayload.player.id, restartReadyPlayer.playerId)

  const restartedPayloads = await waitForAll(
    players,
    EVENTS.server.GAME_RESTARTED,
    async () => {
      await emitWithAck(host.socket, EVENTS.client.GAME_RESTART, {})
    }
  )
  restartedPayloads.forEach((payload) => {
    assert.strictEqual(payload.room.status, 'waiting')
    payload.room.players.forEach((player) => {
      assert.strictEqual(player.isReady, false)
    })
  })

  await emitWithAck(extraPlayer.socket, EVENTS.client.ROOM_JOIN, {
    roomId,
    nickname: extraPlayer.nickname,
    avatar: extraPlayer.avatar,
  })

  return {
    roomId,
    restartReadyPlayer,
  }
}

async function scenarioTieThenSpyWin(host, players) {
  await emitWithAck(host.socket, EVENTS.client.ROOM_SET_SPY_COUNT, {
    spyCount: 2,
  })
  await readyPlayers(players.slice(1))

  const startedSnapshots = await startGame(host, players)
  const groupedPlayers = groupPlayersByWord(startedSnapshots, players)
  assert.deepStrictEqual(
    groupedPlayers.map((group) => group.length).sort((left, right) => left - right),
    [2, 4]
  )

  const spyPlayers = groupedPlayers.find((group) => group.length === 2)
  const civilianPlayers = groupedPlayers.find((group) => group.length === 4)

  await confirmAllWords(players)
  await startVote(host, players)

  const tieResultPromises = players.map((player) =>
    waitForEvent(player.socket, EVENTS.server.GAME_RESULT)
  )
  await emitWithAck(civilianPlayers[0].socket, EVENTS.client.GAME_VOTE, {
    targetId: spyPlayers[0].playerId,
  })
  await emitWithAck(civilianPlayers[1].socket, EVENTS.client.GAME_VOTE, {
    targetId: spyPlayers[0].playerId,
  })
  await emitWithAck(spyPlayers[0].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[0].playerId,
  })
  await emitWithAck(spyPlayers[1].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[0].playerId,
  })
  await emitWithAck(civilianPlayers[2].socket, EVENTS.client.GAME_VOTE, {
    targetId: null,
  })
  await emitWithAck(civilianPlayers[3].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[1].playerId,
  })

  const tieResults = await Promise.all(tieResultPromises)
  tieResults.forEach((snapshot) => {
    assert.strictEqual(snapshot.phase, 'result')
    assert.strictEqual(snapshot.currentResult.isTie, true)
    assert.strictEqual(snapshot.currentResult.eliminated, null)
    assert.strictEqual(snapshot.finalResult, null)
    assert.strictEqual(snapshot.roundHistory.length, 1)
  })

  const nextRoundSnapshots = await continueGame(
    host,
    players,
    EVENTS.server.GAME_NEXT_ROUND
  )
  nextRoundSnapshots.forEach((snapshot) => {
    assert.strictEqual(snapshot.phase, 'speaking')
    assert.strictEqual(snapshot.round, 2)
  })

  await startVote(host, players)

  const roundTwoResultPromises = players.map((player) =>
    waitForEvent(player.socket, EVENTS.server.GAME_RESULT)
  )
  await emitWithAck(spyPlayers[0].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[0].playerId,
  })
  await emitWithAck(spyPlayers[1].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[0].playerId,
  })
  await emitWithAck(civilianPlayers[1].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[0].playerId,
  })
  await emitWithAck(civilianPlayers[2].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[0].playerId,
  })
  await emitWithAck(civilianPlayers[0].socket, EVENTS.client.GAME_VOTE, {
    targetId: spyPlayers[0].playerId,
  })
  await emitWithAck(civilianPlayers[3].socket, EVENTS.client.GAME_VOTE, {
    targetId: spyPlayers[0].playerId,
  })

  const roundTwoResults = await Promise.all(roundTwoResultPromises)
  roundTwoResults.forEach((snapshot) => {
    assert.strictEqual(snapshot.phase, 'result')
    assert.strictEqual(snapshot.currentResult.eliminated, civilianPlayers[0].playerId)
    assert.strictEqual(snapshot.finalResult, null)
    assert.strictEqual(snapshot.roundHistory.length, 2)
  })

  const roundThreeSnapshots = await continueGame(
    host,
    players,
    EVENTS.server.GAME_NEXT_ROUND
  )
  roundThreeSnapshots.forEach((snapshot) => {
    assert.strictEqual(snapshot.phase, 'speaking')
    assert.strictEqual(snapshot.round, 3)
  })

  const aliveRoundThreePlayers = players.filter(
    (player) => player.playerId !== civilianPlayers[0].playerId
  )
  await startVote(host, aliveRoundThreePlayers)

  const finalResultPromises = aliveRoundThreePlayers.map((player) =>
    waitForEvent(player.socket, EVENTS.server.GAME_RESULT)
  )
  await emitWithAck(spyPlayers[0].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[1].playerId,
  })
  await emitWithAck(spyPlayers[1].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[1].playerId,
  })
  await emitWithAck(civilianPlayers[2].socket, EVENTS.client.GAME_VOTE, {
    targetId: civilianPlayers[1].playerId,
  })
  await emitWithAck(civilianPlayers[1].socket, EVENTS.client.GAME_VOTE, {
    targetId: spyPlayers[0].playerId,
  })
  await emitWithAck(civilianPlayers[3].socket, EVENTS.client.GAME_VOTE, {
    targetId: spyPlayers[0].playerId,
  })

  const finalResults = await Promise.all(finalResultPromises)
  finalResults.forEach((snapshot) => {
    assert.strictEqual(snapshot.phase, 'ended')
    assert.strictEqual(snapshot.currentResult.eliminated, civilianPlayers[1].playerId)
    assert.strictEqual(snapshot.finalResult.winner, 'spy')
    assert.strictEqual(snapshot.roundHistory.length, 3)
  })

  const endedSnapshots = await continueGame(
    host,
    aliveRoundThreePlayers,
    EVENTS.server.GAME_ENDED
  )
  endedSnapshots.forEach((snapshot) => {
    assert.strictEqual(snapshot.finalResult.winner, 'spy')
    assert.ok(snapshot.roles)
    assert.ok(snapshot.wordPair)
    assert.strictEqual(snapshot.roundHistory.length, 3)
  })
}

async function main() {
  const host = await connectClient()
  const playerA = await connectClient()
  const playerB = await connectClient()
  const playerC = await connectClient()
  const playerD = await connectClient()
  const playerE = await connectClient()

  playerA.nickname = '玩家甲'
  playerA.avatar = 'a'
  playerB.nickname = '玩家乙'
  playerB.avatar = 'b'
  playerC.nickname = '玩家丙'
  playerC.avatar = 'c'
  playerD.nickname = '玩家丁'
  playerD.avatar = 'd'
  playerE.nickname = '玩家戊'
  playerE.avatar = 'e'

  const roomPlayers = [host, playerA, playerB, playerC]
  host.nickname = '房主'
  host.avatar = 'host'

  try {
    const { roomId } = await scenarioCivilianWin(host, roomPlayers, playerD)
    await emitWithAck(playerE.socket, EVENTS.client.ROOM_JOIN, {
      roomId,
      nickname: playerE.nickname,
      avatar: playerE.avatar,
    })
    await scenarioTieThenSpyWin(host, [host, playerA, playerB, playerC, playerD, playerE])
    console.log('Phase 3 smoke test passed.')
  } finally {
    ;[host, playerA, playerB, playerC, playerD, playerE].forEach((client) => {
      client.socket.close()
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
