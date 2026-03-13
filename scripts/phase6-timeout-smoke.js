/* eslint-disable no-console */
const assert = require('assert')
const { io } = require('socket.io-client')
const EVENTS = require('../src/socket/events')

const SERVER_URL = process.env.SMOKE_SERVER_URL || 'http://127.0.0.1:3020'

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler)
      reject(new Error(`等待事件超时: ${eventName}`))
    }, timeoutMs)

    const handler = (payload) => {
      clearTimeout(timer)
      socket.off(eventName, handler)
      resolve(payload)
    }

    socket.on(eventName, handler)
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
    nickname: `超时玩家${index + 1}`,
    avatar: `timeout-avatar-${index + 1}`,
  }
}

async function waitForAll(clients, eventName, trigger, timeoutMs = 5000) {
  const promises = clients.map((client) =>
    waitForEvent(client.socket, eventName, timeoutMs)
  )
  await trigger()
  return Promise.all(promises)
}

async function main() {
  const clients = await Promise.all(
    Array.from({ length: 4 }, (_, index) => connectClient(index))
  )
  const [host, ...guests] = clients

  try {
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
      await emitWithAck(guest.socket, EVENTS.client.ROOM_READY, {
        isReady: true,
      })
    }

    await waitForAll(clients, EVENTS.server.GAME_STARTED, async () => {
      await emitWithAck(host.socket, EVENTS.client.ROOM_START_GAME, {})
    })

    await waitForAll(clients, EVENTS.server.GAME_SPEAKING_STARTED, async () => {
      for (const client of clients) {
        await emitWithAck(client.socket, EVENTS.client.GAME_CONFIRM_WORD, {})
      }
    })

    const voteStartedPayloads = await waitForAll(
      clients,
      EVENTS.server.GAME_VOTE_STARTED,
      async () => {
        await emitWithAck(host.socket, EVENTS.client.GAME_START_VOTE, {})
      }
    )

    voteStartedPayloads.forEach((payload) => {
      assert.strictEqual(payload.phase, 'voting')
      assert.ok(payload.voteReminderMs <= payload.voteTimeoutMs)
    })

    const voteReminderPayloads = await Promise.all(
      clients.map((client) =>
        waitForEvent(client.socket, EVENTS.server.GAME_VOTE_REMINDER, 5000)
      )
    )
    voteReminderPayloads.forEach((payload) => {
      assert.strictEqual(payload.roomId, roomId)
      assert.deepStrictEqual(
        payload.pendingPlayerIds.slice().sort(),
        clients.map((client) => client.playerId).sort()
      )
    })

    const resultPayloads = await Promise.all(
      clients.map((client) =>
        waitForEvent(client.socket, EVENTS.server.GAME_RESULT, 5000)
      )
    )
    resultPayloads.forEach((payload) => {
      assert.strictEqual(payload.phase, 'result')
      assert.strictEqual(payload.currentResult.eliminated, null)
      assert.strictEqual(payload.currentResult.isTie, false)
      assert.deepStrictEqual(payload.currentResult.leaderboard, [])
      assert.deepStrictEqual(
        Object.values(payload.currentResult.votes),
        [null, null, null, null]
      )
    })

    console.log('Phase 6 timeout smoke test passed.')
  } finally {
    clients.forEach((client) => {
      client.socket.close()
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
