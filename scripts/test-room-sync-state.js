const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')

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
  })
}

function connectPlayer(roomManager, socketId) {
  return roomManager.registerConnection({ socketId, identityKey: socketId }).playerId
}

function createWaitingRoom(roomManager) {
  const hostId = connectPlayer(roomManager, 'socket-host')
  const guestAId = connectPlayer(roomManager, 'socket-a')
  const guestBId = connectPlayer(roomManager, 'socket-b')
  const guestCId = connectPlayer(roomManager, 'socket-c')

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
  roomManager.joinRoom(room.id, {
    playerId: guestCId,
    nickname: '玩家丙',
    avatar: 'c.png',
  })

  return {
    roomId: room.id,
    hostId,
    guestAId,
    guestBId,
    guestCId,
  }
}

function testWaitingRoomSyncState() {
  const roomManager = createRoomManager()
  const { roomId, hostId } = createWaitingRoom(roomManager)

  const response = roomManager.getSyncState(hostId)

  assert.strictEqual(response.room.roomId, roomId)
  assert.strictEqual(response.game, null)
  assert.strictEqual(response.status, 'waiting')

  roomManager.destroyRoom(roomId)
}

function testPlayingRoomSyncState() {
  const roomManager = createRoomManager()
  const { roomId, hostId, guestAId } = createWaitingRoom(roomManager)

  roomManager.startGame(hostId, 'language')
  const response = roomManager.getSyncState(guestAId)

  assert.strictEqual(response.room.roomId, roomId)
  assert.strictEqual(response.status, 'dealing')
  assert.strictEqual(response.game.phase, 'dealing')
  assert.ok(response.game.myWord)
  assert.ok(response.game.myRole)

  roomManager.destroyRoom(roomId)
}

function testClosedRoomSyncState() {
  const roomManager = createRoomManager()
  const { roomId, hostId } = createWaitingRoom(roomManager)

  roomManager.closeRoom(roomId, { reason: 'manual_close' })

  assert.throws(
    () => roomManager.getSyncState(hostId),
    (error) => error && error.message === '房间不存在或已关闭'
  )
}

function main() {
  testWaitingRoomSyncState()
  testPlayingRoomSyncState()
  testClosedRoomSyncState()
  console.log('Room sync state test passed.')
}

main()
