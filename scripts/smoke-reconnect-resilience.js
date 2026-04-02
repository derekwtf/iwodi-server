/* eslint-disable no-console */
const assert = require('assert')
const { io } = require('socket.io-client')
const EVENTS = require('../src/socket/events')

const SERVER_URL = process.env.SMOKE_SERVER_URL || 'http://127.0.0.1:3026'

function waitForEvent(socket, eventName, timeoutMs = 5000, matcher) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handleEvent)
      reject(new Error(`等待事件超时: ${eventName}`))
    }, timeoutMs)

    const handleEvent = (payload) => {
      if (matcher && !matcher(payload)) {
        return
      }

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

function emitExpectError(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(eventName, payload, (response) => {
      if (!response || response.ok) {
        reject(new Error(`${eventName} 未按预期失败: ${JSON.stringify(response)}`))
        return
      }

      resolve(response)
    })
  })
}

async function connectClient(index, playerId) {
  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: playerId ? { playerId } : {},
  })

  const connectSuccess = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
  socket.connect()
  const connectPayload = await connectSuccess

  return {
    socket,
    playerId: connectPayload.playerId,
    nickname: `重连玩家${index + 1}`,
    avatar: `reconnect-avatar-${index + 1}`,
  }
}

async function reconnectClient(index, playerId) {
  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: { playerId },
  })

  const connectSuccess = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
  const reconnectRoomState = waitForEvent(
    socket,
    EVENTS.server.RECONNECT_ROOM_STATE,
    2000
  )
  socket.connect()

  const connectPayload = await connectSuccess
  const reconnectPayload = await reconnectRoomState

  return {
    socket,
    playerId: connectPayload.playerId,
    nickname: `重连玩家${index + 1}`,
    avatar: `reconnect-avatar-${index + 1}`,
    reconnectPayload,
  }
}

async function main() {
  let host = null
  let guest = null
  let hostRecovered = null
  let guestRecovered = null

  try {
    host = await connectClient(0)
    guest = await connectClient(1)

    const createResult = await emitWithAck(host.socket, EVENTS.client.ROOM_CREATE, {
      nickname: host.nickname,
      avatar: host.avatar,
    })
    const roomId = createResult.room.roomId

    await emitWithAck(guest.socket, EVENTS.client.ROOM_JOIN, {
      roomId,
      nickname: guest.nickname,
      avatar: guest.avatar,
    })

    const guestDisconnected = waitForEvent(
      host.socket,
      EVENTS.server.ROOM_PLAYER_DISCONNECTED,
      2000,
      (payload) => payload.player && payload.player.id === guest.playerId
    )
    guest.socket.close()
    await guestDisconnected

    await new Promise((resolve) => setTimeout(resolve, 300))
    const hostSync = await emitWithAck(host.socket, EVENTS.client.ROOM_SYNC_STATE, {})
    assert.strictEqual(hostSync.room.roomId, roomId)
    assert.strictEqual(hostSync.room.playerCount, 2)
    assert.strictEqual(
      hostSync.room.players.find((item) => item.id === guest.playerId).disconnected,
      true
    )

    guestRecovered = await reconnectClient(1, guest.playerId)
    assert.strictEqual(guestRecovered.reconnectPayload.roomId, roomId)

    const hostChanged = waitForEvent(
      guestRecovered.socket,
      EVENTS.server.ROOM_HOST_CHANGED,
      2000,
      (payload) => payload.player && payload.player.id === guest.playerId
    )
    host.socket.close()
    const hostChangedPayload = await hostChanged
    assert.strictEqual(hostChangedPayload.player.id, guest.playerId)

    guestRecovered.socket.close()
    await new Promise((resolve) => setTimeout(resolve, 300))

    hostRecovered = await reconnectClient(0, host.playerId)
    assert.strictEqual(hostRecovered.reconnectPayload.roomId, roomId)
    assert.strictEqual(
      hostRecovered.reconnectPayload.players.find((item) => item.id === host.playerId).isHost,
      true
    )

    hostRecovered.socket.close()
    await new Promise((resolve) => setTimeout(resolve, 950))

    const expiredClient = await connectClient(1, guest.playerId)
    const syncError = await emitExpectError(
      expiredClient.socket,
      EVENTS.client.ROOM_SYNC_STATE,
      {}
    )
    assert.strictEqual(syncError.error.code, 'ROOM_NOT_FOUND')
    expiredClient.socket.close()

    console.log('Reconnect resilience smoke test passed.')
  } finally {
    if (host && host.socket) {
      host.socket.close()
    }
    if (guest && guest.socket) {
      guest.socket.close()
    }
    if (hostRecovered && hostRecovered.socket) {
      hostRecovered.socket.close()
    }
    if (guestRecovered && guestRecovered.socket) {
      guestRecovered.socket.close()
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
