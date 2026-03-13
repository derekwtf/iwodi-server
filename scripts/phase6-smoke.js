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

function emitExpectFailure(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(eventName, payload, (response) => {
      if (response && response.ok) {
        reject(new Error(`${eventName} 预期失败但成功: ${JSON.stringify(response)}`))
        return
      }

      resolve(response)
    })
  })
}

async function connectClient(index) {
  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: {},
  })

  const connectPromise = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
  socket.connect()
  const connectPayload = await connectPromise

  return {
    socket,
    playerId: connectPayload.playerId,
    nickname: `玩家${index + 1}`,
    avatar: `avatar-${index + 1}`,
  }
}

async function joinRoom(host, guests) {
  const createResult = await emitWithAck(host.socket, EVENTS.client.ROOM_CREATE, {
    nickname: host.nickname,
    avatar: host.avatar,
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

async function waitForAll(clients, eventName, trigger, timeoutMs = 5000) {
  const promises = clients.map((client) =>
    waitForEvent(client.socket, eventName, timeoutMs)
  )
  await trigger()
  return Promise.all(promises)
}

async function scenarioHostTransferAndAllAbstain(clients) {
  const [host, guestA, guestB, guestC, guestD] = clients
  const roomId = await joinRoom(host, [guestA, guestB, guestC, guestD])
  assert.match(roomId, /^\d{6}$/)

  const hostChangedInWaiting = waitForAll(
    [guestA, guestB, guestC, guestD],
    EVENTS.server.ROOM_HOST_CHANGED,
    async () => {
      await emitWithAck(host.socket, EVENTS.client.ROOM_LEAVE, {})
    }
  )
  const waitingHostChangedPayloads = await hostChangedInWaiting
  waitingHostChangedPayloads.forEach((payload) => {
    assert.ok([guestA, guestB, guestC, guestD].some((player) => player.playerId === payload.player.id))
    assert.strictEqual(payload.room.playerCount, 4)
  })

  const startedSnapshots = await waitForAll(
    [guestA, guestB, guestC, guestD],
    EVENTS.server.GAME_STARTED,
    async () => {
      await emitWithAck(guestA.socket, EVENTS.client.ROOM_START_GAME, {})
    }
  )
  startedSnapshots.forEach((snapshot) => {
    assert.strictEqual(snapshot.phase, 'dealing')
    assert.ok(snapshot.myWord)
  })

  const words = new Map()
  startedSnapshots.forEach((snapshot, index) => {
    const player = [guestA, guestB, guestC, guestD][index]
    if (!words.has(snapshot.myWord)) {
      words.set(snapshot.myWord, [])
    }
    words.get(snapshot.myWord).push(player)
  })
  const departingHostIsSpy = Array.from(words.values()).some(
    (group) => group.length === 1 && group[0].playerId === guestA.playerId
  )

  await waitForAll(
    [guestA, guestB, guestC, guestD],
    EVENTS.server.GAME_SPEAKING_STARTED,
    async () => {
      for (const player of [guestA, guestB, guestC, guestD]) {
        await emitWithAck(player.socket, EVENTS.client.GAME_CONFIRM_WORD, {})
      }
    }
  )

  const hostChangedPromises = [guestB, guestC, guestD].map((client) =>
    waitForEvent(client.socket, EVENTS.server.ROOM_HOST_CHANGED)
  )
  const endedPromises = departingHostIsSpy
    ? [guestB, guestC, guestD].map((client) =>
      waitForEvent(client.socket, EVENTS.server.GAME_ENDED)
    )
    : []

  await emitWithAck(guestA.socket, EVENTS.client.ROOM_LEAVE, {})

  const playingHostChangedPayloads = await Promise.all(hostChangedPromises)
  playingHostChangedPayloads.forEach((payload) => {
    assert.ok([guestB, guestC, guestD].some((player) => player.playerId === payload.player.id))
    assert.strictEqual(payload.room.playerCount, 3)
    assert.strictEqual(payload.room.gamePhase, departingHostIsSpy ? 'ended' : 'speaking')
  })

  if (departingHostIsSpy) {
    const endedPayloads = await Promise.all(endedPromises)
    endedPayloads.forEach((payload) => {
      assert.strictEqual(payload.finalResult.winner, 'civilian')
      const formerHost = payload.players.find((player) => player.id === guestA.playerId)
      assert.ok(formerHost)
      assert.strictEqual(formerHost.hasLeft, true)
    })
    return
  }

  const voteStartedPayloads = await waitForAll(
    [guestB, guestC, guestD],
    EVENTS.server.GAME_VOTE_STARTED,
    async () => {
      await emitWithAck(guestB.socket, EVENTS.client.GAME_START_VOTE, {})
    }
  )
  voteStartedPayloads.forEach((payload) => {
    assert.strictEqual(payload.phase, 'voting')
    const formerHost = payload.players.find((player) => player.id === guestA.playerId)
    assert.ok(formerHost)
    assert.strictEqual(formerHost.hasLeft, true)
  })

  const allAbstainResults = await waitForAll(
    [guestB, guestC, guestD],
    EVENTS.server.GAME_RESULT,
    async () => {
      for (const player of [guestB, guestC, guestD]) {
        await emitWithAck(player.socket, EVENTS.client.GAME_VOTE, {
          targetId: null,
        })
      }
    }
  )
  allAbstainResults.forEach((payload) => {
    assert.strictEqual(payload.phase, departingHostIsSpy ? 'ended' : 'result')
    assert.strictEqual(payload.currentResult.eliminated, null)
    assert.strictEqual(payload.currentResult.eliminatedVotes, 0)
    assert.deepStrictEqual(payload.currentResult.leaderboard, [])
    const formerHost = payload.players.find((player) => player.id === guestA.playerId)
    assert.ok(formerHost)
    assert.strictEqual(formerHost.hasLeft, true)
    if (departingHostIsSpy) {
      assert.strictEqual(payload.finalResult.winner, 'civilian')
    } else {
      assert.strictEqual(payload.finalResult, null)
    }
  })

  if (departingHostIsSpy) {
    const endedPayloads = await waitForAll(
      [guestB, guestC, guestD],
      EVENTS.server.GAME_ENDED,
      async () => {
        await emitWithAck(guestB.socket, EVENTS.client.GAME_CONTINUE, {})
      }
    )
    endedPayloads.forEach((payload) => {
      assert.strictEqual(payload.finalResult.winner, 'civilian')
      const formerHost = payload.players.find((player) => player.id === guestA.playerId)
      assert.ok(formerHost)
      assert.strictEqual(formerHost.hasLeft, true)
    })
  } else {
    const nextRoundPayloads = await waitForAll(
      [guestB, guestC, guestD],
      EVENTS.server.GAME_NEXT_ROUND,
      async () => {
        await emitWithAck(guestB.socket, EVENTS.client.GAME_CONTINUE, {})
      }
    )
    nextRoundPayloads.forEach((payload) => {
      assert.strictEqual(payload.phase, 'speaking')
      assert.strictEqual(payload.round, 2)
    })
  }
}

async function scenarioLeaveAutoProgress(clients) {
  const [host, guestA, guestB, guestC] = clients
  const roomId = await joinRoom(host, [guestA, guestB, guestC])
  assert.match(roomId, /^\d{6}$/)

  const startedSnapshots = await waitForAll(
    [host, guestA, guestB, guestC],
    EVENTS.server.GAME_STARTED,
    async () => {
      await emitWithAck(host.socket, EVENTS.client.ROOM_START_GAME, {})
    }
  )

  const words = new Map()
  startedSnapshots.forEach((snapshot, index) => {
    const player = [host, guestA, guestB, guestC][index]
    if (!words.has(snapshot.myWord)) {
      words.set(snapshot.myWord, [])
    }
    words.get(snapshot.myWord).push(player)
  })

  const groupedPlayers = Array.from(words.values()).sort(
    (left, right) => left.length - right.length
  )
  assert.deepStrictEqual(groupedPlayers.map((group) => group.length), [1, 3])

  const spyPlayer = groupedPlayers[0][0]
  const civilianPlayers = groupedPlayers[1]
  const leavingCivilian = civilianPlayers[2]

  const speakingPayloadsPromise = Promise.all(
    [host, guestA, guestB].map((client) =>
      waitForEvent(client.socket, EVENTS.server.GAME_SPEAKING_STARTED)
    )
  )

  for (const player of [host, civilianPlayers[0], civilianPlayers[1]]) {
    await emitWithAck(player.socket, EVENTS.client.GAME_CONFIRM_WORD, {})
  }
  await emitWithAck(leavingCivilian.socket, EVENTS.client.ROOM_LEAVE, {})

  const speakingPayloads = await speakingPayloadsPromise
  speakingPayloads.forEach((payload) => {
    assert.strictEqual(payload.phase, 'speaking')
    assert.strictEqual(payload.alivePlayers.length, 3)
    const formerPlayer = payload.players.find((player) => player.id === leavingCivilian.playerId)
    assert.ok(formerPlayer)
    assert.strictEqual(formerPlayer.hasLeft, true)
  })

  await waitForAll(
    [host, guestA, guestB],
    EVENTS.server.GAME_VOTE_STARTED,
    async () => {
      const currentHost = speakingPayloads[0].players.find((player) => player.isHost)
      const actingHost = [host, guestA, guestB].find(
        (player) => player.playerId === currentHost.id
      )
      await emitWithAck(actingHost.socket, EVENTS.client.GAME_START_VOTE, {})
    }
  )

  const remainingClients = [host, guestA, guestB].filter(
    (player) => player.playerId !== spyPlayer.playerId
  )
  const activeCivilian = remainingClients.find((player) => player.playerId !== host.playerId)
  const survivorClients = [host, guestA, guestB].filter(
    (player) => player.playerId !== activeCivilian.playerId
  )
  const resultPayloadsPromise = Promise.all(
    survivorClients.map((client) =>
      waitForEvent(client.socket, EVENTS.server.GAME_RESULT)
    )
  )
  await emitWithAck(spyPlayer.socket, EVENTS.client.GAME_VOTE, {
    targetId: activeCivilian.playerId,
  })
  await emitWithAck(host.socket, EVENTS.client.GAME_VOTE, {
    targetId: spyPlayer.playerId,
  })
  await emitWithAck(activeCivilian.socket, EVENTS.client.ROOM_LEAVE, {})

  const resultPayloads = await resultPayloadsPromise
  resultPayloads.forEach((payload) => {
    assert.strictEqual(payload.phase, 'result')
    assert.strictEqual(payload.currentResult.eliminated, null)
    assert.strictEqual(payload.alivePlayers.length, 2)
    const formerPlayer = payload.players.find((player) => player.id === activeCivilian.playerId)
    assert.ok(formerPlayer)
    assert.strictEqual(formerPlayer.hasLeft, true)
  })
}

async function scenarioRoomCapacity(clients) {
  const [host, ...guests] = clients
  const roomId = await joinRoom(host, guests.slice(0, 11))
  assert.match(roomId, /^\d{6}$/)

  const overflowResponse = await emitExpectFailure(
    guests[11].socket,
    EVENTS.client.ROOM_JOIN,
    {
      roomId,
      nickname: guests[11].nickname,
      avatar: guests[11].avatar,
    }
  )

  assert.strictEqual(overflowResponse.ok, false)
  assert.strictEqual(overflowResponse.error.code, 'ROOM_FULL')
}

async function scenarioTwoCiviliansOneSpyContinue(clients) {
  const [host, guestA, guestB, guestC] = clients
  const roomId = await joinRoom(host, [guestA, guestB, guestC])
  assert.match(roomId, /^\d{6}$/)

  const startedSnapshots = await waitForAll(
    [host, guestA, guestB, guestC],
    EVENTS.server.GAME_STARTED,
    async () => {
      await emitWithAck(host.socket, EVENTS.client.ROOM_START_GAME, {})
    }
  )

  const words = new Map()
  startedSnapshots.forEach((snapshot, index) => {
    const player = [host, guestA, guestB, guestC][index]
    if (!words.has(snapshot.myWord)) {
      words.set(snapshot.myWord, [])
    }
    words.get(snapshot.myWord).push(player)
  })

  const groupedPlayers = Array.from(words.values()).sort(
    (left, right) => left.length - right.length
  )
  assert.deepStrictEqual(groupedPlayers.map((group) => group.length), [1, 3])

  const spyPlayer = groupedPlayers[0][0]
  const civilianPlayers = groupedPlayers[1]
  const eliminatedCivilian = civilianPlayers[0]

  await waitForAll(
    [host, guestA, guestB, guestC],
    EVENTS.server.GAME_SPEAKING_STARTED,
    async () => {
      for (const player of [host, guestA, guestB, guestC]) {
        await emitWithAck(player.socket, EVENTS.client.GAME_CONFIRM_WORD, {})
      }
    }
  )

  await waitForAll(
    [host, guestA, guestB, guestC],
    EVENTS.server.GAME_VOTE_STARTED,
    async () => {
      await emitWithAck(host.socket, EVENTS.client.GAME_START_VOTE, {})
    }
  )

  const resultPayloads = await waitForAll(
    [host, guestA, guestB, guestC],
    EVENTS.server.GAME_RESULT,
    async () => {
      await emitWithAck(spyPlayer.socket, EVENTS.client.GAME_VOTE, {
        targetId: eliminatedCivilian.playerId,
      })
      await emitWithAck(civilianPlayers[1].socket, EVENTS.client.GAME_VOTE, {
        targetId: eliminatedCivilian.playerId,
      })
      await emitWithAck(civilianPlayers[2].socket, EVENTS.client.GAME_VOTE, {
        targetId: eliminatedCivilian.playerId,
      })
      await emitWithAck(eliminatedCivilian.socket, EVENTS.client.GAME_VOTE, {
        targetId: spyPlayer.playerId,
      })
    }
  )

  resultPayloads.forEach((payload) => {
    assert.strictEqual(payload.phase, 'result')
    assert.strictEqual(payload.finalResult, null)
    assert.strictEqual(payload.currentResult.eliminated, eliminatedCivilian.playerId)
    assert.strictEqual(payload.alivePlayers.length, 3)
  })

  const nextRoundPayloads = await waitForAll(
    [host, guestA, guestB, guestC],
    EVENTS.server.GAME_NEXT_ROUND,
    async () => {
      await emitWithAck(host.socket, EVENTS.client.GAME_CONTINUE, {})
    }
  )

  nextRoundPayloads.forEach((payload) => {
    assert.strictEqual(payload.phase, 'speaking')
    assert.strictEqual(payload.round, 2)
    assert.strictEqual(payload.alivePlayers.length, 3)
    assert.ok(payload.alivePlayers.includes(spyPlayer.playerId))
  })
}

async function main() {
  const scenarioOneClients = await Promise.all(
    Array.from({ length: 5 }, (_, index) => connectClient(index))
  )
  const scenarioTwoClients = await Promise.all(
    Array.from({ length: 13 }, (_, index) => connectClient(index + 10))
  )
  const scenarioThreeClients = await Promise.all(
    Array.from({ length: 4 }, (_, index) => connectClient(index + 30))
  )
  const scenarioFourClients = await Promise.all(
    Array.from({ length: 4 }, (_, index) => connectClient(index + 40))
  )

  try {
    await scenarioHostTransferAndAllAbstain(scenarioOneClients)
    await scenarioRoomCapacity(scenarioTwoClients)
    await scenarioTwoCiviliansOneSpyContinue(scenarioThreeClients)
    await scenarioLeaveAutoProgress(scenarioFourClients)
    console.log('Phase 6 smoke test passed.')
  } finally {
    ;[...scenarioOneClients, ...scenarioTwoClients, ...scenarioThreeClients, ...scenarioFourClients].forEach((client) => {
      client.socket.close()
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
