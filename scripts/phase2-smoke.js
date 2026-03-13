/* eslint-disable no-console */
const assert = require('assert')
const { io } = require('socket.io-client')
const EVENTS = require('../src/socket/events')

const SERVER_URL = process.env.SMOKE_SERVER_URL || 'http://127.0.0.1:3010'
const DISCONNECT_GRACE_MS = Number(process.env.SMOKE_DISCONNECT_GRACE_MS || 30000)

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

async function connectClient(existingPlayerId, followUpEventName = null) {
  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: existingPlayerId ? { playerId: existingPlayerId } : {},
  })

  const connectPromise = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
  const followUpPromise = followUpEventName
    ? waitForEvent(socket, followUpEventName)
    : null
  socket.connect()
  const connectPayload = await connectPromise
  return {
    socket,
    playerId: connectPayload.playerId,
    followUpPromise,
  }
}

async function main() {
  const host = await connectClient()
  const guest = await connectClient()
  const watcher = await connectClient()
  const helper = await connectClient()

  try {
    const roomCreated = await emitWithAck(host.socket, EVENTS.client.ROOM_CREATE, {
      nickname: '房主',
      avatar: 'host-avatar',
    })
    const roomId = roomCreated.room.roomId
    assert.match(roomId, /^\d{6}$/)

    const joinedEvent = waitForEvent(host.socket, EVENTS.server.ROOM_PLAYER_JOINED)
    await emitWithAck(guest.socket, EVENTS.client.ROOM_JOIN, {
      roomId,
      nickname: '玩家甲',
      avatar: 'guest-a',
    })
    const guestJoinedPayload = await joinedEvent
    assert.strictEqual(guestJoinedPayload.player.nickname, '玩家甲')

    await emitWithAck(watcher.socket, EVENTS.client.ROOM_JOIN, {
      roomId,
      nickname: '玩家乙',
      avatar: 'guest-b',
    })

    await emitWithAck(helper.socket, EVENTS.client.ROOM_JOIN, {
      roomId,
      nickname: '玩家丙',
      avatar: 'guest-c',
    })

    await emitWithAck(guest.socket, EVENTS.client.ROOM_READY, { isReady: true })
    await emitWithAck(watcher.socket, EVENTS.client.ROOM_READY, { isReady: true })
    await emitWithAck(helper.socket, EVENTS.client.ROOM_READY, { isReady: true })
    await emitWithAck(host.socket, EVENTS.client.ROOM_SET_SPY_COUNT, { spyCount: 1 })

    const gameStartedForHost = waitForEvent(host.socket, EVENTS.server.GAME_STARTED)
    const gameStartedForGuest = waitForEvent(guest.socket, EVENTS.server.GAME_STARTED)
    const gameStartedForWatcher = waitForEvent(
      watcher.socket,
      EVENTS.server.GAME_STARTED
    )
    const gameStartedForHelper = waitForEvent(
      helper.socket,
      EVENTS.server.GAME_STARTED
    )

    await emitWithAck(host.socket, EVENTS.client.ROOM_START_GAME, {})

    const [hostGame, guestGame, watcherGame, helperGame] = await Promise.all([
      gameStartedForHost,
      gameStartedForGuest,
      gameStartedForWatcher,
      gameStartedForHelper,
    ])

    ;[hostGame, guestGame, watcherGame, helperGame].forEach((snapshot) => {
      assert.ok(snapshot.myWord)
      assert.ok(!('roles' in snapshot))
      assert.ok(!('wordPair' in snapshot))
      assert.ok(!('playerWords' in snapshot))
    })

    guest.socket.disconnect()

    const reconnectClient = await connectClient(
      guest.playerId,
      EVENTS.server.RECONNECT_GAME_SNAPSHOT
    )
    try {
      const reconnectSnapshot = await reconnectClient.followUpPromise
      assert.ok(reconnectSnapshot.myWord)
      assert.ok(!('roles' in reconnectSnapshot))
      assert.ok(!('wordPair' in reconnectSnapshot))
      assert.ok(!('playerWords' in reconnectSnapshot))

      const hostChangedEvent = waitForEvent(
        watcher.socket,
        EVENTS.server.ROOM_HOST_CHANGED
      )
      await emitWithAck(host.socket, EVENTS.client.RECONNECT_ABANDON, {})
      const hostChangedPayload = await hostChangedEvent
      assert.ok(
        ['玩家甲', '玩家乙', '玩家丙'].includes(hostChangedPayload.player.nickname)
      )
      assert.strictEqual(hostChangedPayload.room.playerCount, 3)

      reconnectClient.socket.disconnect()
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(DISCONNECT_GRACE_MS + 500, 31000))
      )

      const expiredClient = await connectClient(
        '00000000-0000-4000-8000-000000000001',
        EVENTS.server.RECONNECT_EXPIRED
      )
      try {
        const expiredPayload = await expiredClient.followUpPromise
        assert.ok(expiredPayload.reason)
      } finally {
        expiredClient.socket.close()
      }
    } finally {
      reconnectClient.socket.close()
    }

    console.log('Phase 2 smoke test passed.')
  } finally {
    host.socket.close()
    guest.socket.close()
    watcher.socket.close()
    helper.socket.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
