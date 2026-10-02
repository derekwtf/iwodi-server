const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForEvent(emitter, eventName, matcher, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, handleEvent)
      reject(new Error(`等待事件超时: ${eventName}`))
    }, timeoutMs)

    const handleEvent = (payload) => {
      if (matcher && !matcher(payload)) {
        return
      }

      clearTimeout(timer)
      emitter.off(eventName, handleEvent)
      resolve(payload)
    }

    emitter.on(eventName, handleEvent)
  })
}

function createRoomManager() {
  return new RoomManager({
    wordLibrary: {
      getRandomPair() {
        return {
          index: 1,
          groupId: 'food-1',
          categoryId: 'food',
          categoryLabel: '美食',
          candidateWords: ['饺子', '包子'],
          civilian: '饺子',
          spy: '包子',
        }
      },
    },
    hostTransferGraceMs: 30,
    allDisconnectedTtlMs: 70,
    waitingIdleMs: 500,
    playingIdleMs: 500,
    endedIdleMs: 500,
    idleWarningMs: 100,
  })
}

function connectPlayer(roomManager, socketId) {
  return roomManager.registerConnection({ socketId, identityKey: socketId }).playerId
}

function createWaitingRoom(roomManager) {
  const hostId = connectPlayer(roomManager, 'socket-host')
  const guestAId = connectPlayer(roomManager, 'socket-a')
  const guestBId = connectPlayer(roomManager, 'socket-b')

  const { room } = roomManager.createRoom({
    playerId: hostId,
    nickname: '房主',
    avatar: 'host.png',
  })

  roomManager.joinRoom(room.id, {
    playerId: guestAId,
    nickname: '玩家甲',
    avatar: 'a.png',
  })
  roomManager.joinRoom(room.id, {
    playerId: guestBId,
    nickname: '玩家乙',
    avatar: 'b.png',
  })

  return {
    roomId: room.id,
    hostId,
    guestAId,
    guestBId,
  }
}

async function testDisconnectedPlayerStaysInRoom() {
  const roomManager = createRoomManager()
  const { roomId, guestAId } = createWaitingRoom(roomManager)

  const disconnectResult = roomManager.markDisconnected('socket-a')
  assert.strictEqual(disconnectResult.roomId, roomId)

  await sleep(50)

  assert.strictEqual(roomManager.getRoomIdForPlayer(guestAId), roomId)
  const player = roomManager.getRoomState(roomId).players.find((item) => item.id === guestAId)
  assert.ok(player)
  assert.strictEqual(player.disconnected, true)
}

async function testHostTransfersToOnlinePlayer() {
  const roomManager = createRoomManager()
  const { roomId, hostId } = createWaitingRoom(roomManager)

  roomManager.markDisconnected('socket-host')
  const transferPayload = await waitForEvent(
    roomManager,
    'room:hostTransferred',
    (payload) => payload.roomId === roomId,
    200
  )

  assert.notStrictEqual(transferPayload.player.id, hostId)
  const roomState = roomManager.getRoomState(roomId)
  const nextHost = roomState.players.find((item) => item.id === transferPayload.player.id)
  assert.ok(nextHost)
  assert.strictEqual(nextHost.isHost, true)
}

async function testReconnectRestoresSameRoom() {
  const roomManager = createRoomManager()
  const { roomId, guestAId } = createWaitingRoom(roomManager)

  roomManager.markDisconnected('socket-a')
  await sleep(50)

  const reconnect = roomManager.registerConnection({
    playerId: guestAId,
    identityKey: roomManager.sessionRegistry.get(guestAId).identityKey,
    socketId: 'socket-a-reconnected',
  })

  assert.strictEqual(reconnect.playerId, guestAId)
  assert.ok(reconnect.reconnectEvent)
  assert.strictEqual(reconnect.reconnectEvent.event, 'reconnect:roomState')
  assert.strictEqual(reconnect.reconnectEvent.payload.roomId, roomId)
  assert.strictEqual(roomManager.getActiveSocketId(guestAId), 'socket-a-reconnected')
}

async function testAllDisconnectedRoomClosesByRoomLifetime() {
  const roomManager = createRoomManager()
  const { roomId } = createWaitingRoom(roomManager)

  roomManager.markDisconnected('socket-host')
  roomManager.markDisconnected('socket-a')
  roomManager.markDisconnected('socket-b')

  await sleep(40)
  assert.ok(roomManager.getRoomState(roomId), '全员离线后房间应仍处于保留期')

  const closePayload = await waitForEvent(
    roomManager,
    'room:closed',
    (payload) => payload.roomId === roomId,
    200
  )

  assert.strictEqual(closePayload.reason, 'all_disconnected_timeout')
}

async function main() {
  await testDisconnectedPlayerStaysInRoom()
  await testHostTransfersToOnlinePlayer()
  await testReconnectRestoresSameRoom()
  await testAllDisconnectedRoomClosesByRoomLifetime()
  console.log('Room reconnect resilience test passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
