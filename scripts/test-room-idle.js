/* eslint-disable no-console */
const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')
const WordLibrary = require('../src/data/WordLibrary')

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

function registerPlayer(roomManager, socketId) {
  return roomManager.registerConnection({ socketId, identityKey: socketId }).playerId
}

function createRoom(roomManager, playerId, nickname) {
  return roomManager.createRoom({
    playerId,
    nickname,
    avatar: `${nickname}-avatar`,
  }).room.id
}

function joinRoom(roomManager, roomId, playerId, nickname) {
  return roomManager.joinRoom(roomId, {
    playerId,
    nickname,
    avatar: `${nickname}-avatar`,
  })
}

function createRoomManager() {
  return new RoomManager({
    wordLibrary: new WordLibrary([{ civilian: '苹果', spy: '香蕉' }]),
    waitingIdleMs: 50,
    playingIdleMs: 70,
    idleWarningMs: 20,
  })
}

async function testWaitingRoomIdleClose() {
  const roomManager = createRoomManager()
  const hostId = registerPlayer(roomManager, 'socket-waiting-host')
  const roomId = createRoom(roomManager, hostId, '房主甲')

  const warningPromise = waitForEvent(
    roomManager,
    'room:idleWarning',
    (payload) => payload.roomId === roomId && payload.reason === 'waiting_idle_timeout'
  )
  const closePromise = waitForEvent(
    roomManager,
    'room:closed',
    (payload) => payload.roomId === roomId && payload.reason === 'waiting_idle_timeout'
  )

  const [warningPayload, closePayload] = await Promise.all([
    warningPromise,
    closePromise,
  ])

  assert.strictEqual(warningPayload.status, 'waiting')
  assert.strictEqual(closePayload.previousStatus, 'waiting')
  assert.strictEqual(roomManager.getRoomState(roomId), null)
  assert.strictEqual(roomManager.getRoomIdForPlayer(hostId), null)
}

async function testWaitingRoomKeepAliveExtendsLifetime() {
  const roomManager = createRoomManager()
  const hostId = registerPlayer(roomManager, 'socket-waiting-keepalive-host')
  const roomId = createRoom(roomManager, hostId, '房主保活')

  await sleep(35)
  roomManager.keepAlive(hostId)
  await sleep(35)
  assert.ok(roomManager.getRoomState(roomId), '点击继续游戏后等待房间不应立即关闭')

  const closePayload = await waitForEvent(
    roomManager,
    'room:closed',
    (payload) => payload.roomId === roomId && payload.reason === 'waiting_idle_timeout'
  )

  assert.strictEqual(closePayload.previousStatus, 'waiting')
}

async function testPlayingRoomHeartbeatExtendsLifetime() {
  const roomManager = createRoomManager()
  const hostId = registerPlayer(roomManager, 'socket-playing-host')
  const guestAId = registerPlayer(roomManager, 'socket-playing-a')
  const guestBId = registerPlayer(roomManager, 'socket-playing-b')
  const guestCId = registerPlayer(roomManager, 'socket-playing-c')
  const roomId = createRoom(roomManager, hostId, '房主乙')

  joinRoom(roomManager, roomId, guestAId, '玩家甲')
  joinRoom(roomManager, roomId, guestBId, '玩家乙')
  joinRoom(roomManager, roomId, guestCId, '玩家丙')
  roomManager.startGame(hostId, 'language')

  await sleep(40)
  roomManager.heartbeat(hostId)
  await sleep(40)
  assert.ok(roomManager.getRoomState(roomId), '心跳后房间不应提前关闭')

  const closePayload = await waitForEvent(
    roomManager,
    'room:closed',
    (payload) => payload.roomId === roomId && payload.reason === 'playing_idle_timeout'
  )

  assert.strictEqual(closePayload.previousStatus, 'playing')
  assert.strictEqual(roomManager.getRoomIdForPlayer(hostId), null)
}

async function testPlayingRoomClosesWithoutHeartbeat() {
  const roomManager = createRoomManager()
  const hostId = registerPlayer(roomManager, 'socket-no-heartbeat-host')
  const guestAId = registerPlayer(roomManager, 'socket-no-heartbeat-a')
  const guestBId = registerPlayer(roomManager, 'socket-no-heartbeat-b')
  const guestCId = registerPlayer(roomManager, 'socket-no-heartbeat-c')
  const roomId = createRoom(roomManager, hostId, '房主丙')

  joinRoom(roomManager, roomId, guestAId, '玩家丁')
  joinRoom(roomManager, roomId, guestBId, '玩家戊')
  joinRoom(roomManager, roomId, guestCId, '玩家己')
  roomManager.startGame(hostId, 'language')

  const closePayload = await waitForEvent(
    roomManager,
    'room:closed',
    (payload) => payload.roomId === roomId && payload.reason === 'playing_idle_timeout'
  )

  assert.strictEqual(closePayload.previousStatus, 'playing')
  assert.strictEqual(roomManager.getRoomState(roomId), null)
}

async function testRestartedRoomIdleClose() {
  const roomManager = createRoomManager()
  const hostId = registerPlayer(roomManager, 'socket-restarted-host')
  const guestAId = registerPlayer(roomManager, 'socket-restarted-a')
  const guestBId = registerPlayer(roomManager, 'socket-restarted-b')
  const guestCId = registerPlayer(roomManager, 'socket-restarted-c')
  const roomId = createRoom(roomManager, hostId, '房主丁')

  joinRoom(roomManager, roomId, guestAId, '玩家庚')
  joinRoom(roomManager, roomId, guestBId, '玩家辛')
  joinRoom(roomManager, roomId, guestCId, '玩家壬')
  roomManager.startGame(hostId, 'language')

  roomManager.restartGame(hostId)
  assert.strictEqual(roomManager.rooms.get(roomId).gameState, null)

  const closePayload = await waitForEvent(
    roomManager,
    'room:closed',
    (payload) => payload.roomId === roomId && payload.reason === 'waiting_idle_timeout'
  )

  assert.strictEqual(closePayload.previousStatus, 'waiting')
  assert.strictEqual(roomManager.getRoomState(roomId), null)
}

async function main() {
  await testWaitingRoomIdleClose()
  await testWaitingRoomKeepAliveExtendsLifetime()
  await testPlayingRoomHeartbeatExtendsLifetime()
  await testPlayingRoomClosesWithoutHeartbeat()
  await testRestartedRoomIdleClose()
  console.log('Room idle test passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
