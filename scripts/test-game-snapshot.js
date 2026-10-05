const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')

const roomManager = new RoomManager({
  wordLibrary: {
    getRandomPair() {
      return {
        index: 7,
        groupId: 'food-001',
        categoryId: 'food',
        categoryLabel: '美食',
        candidateWords: ['饺子', '包子', '馄饨'],
        civilian: '饺子',
        spy: '包子',
      }
    },
  },
})

function connectPlayer(socketId) {
  return roomManager.registerConnection({ socketId, identityKey: socketId }).playerId
}

const hostId = connectPlayer('socket-host')
const guestAId = connectPlayer('socket-a')
const guestBId = connectPlayer('socket-b')
const guestCId = connectPlayer('socket-c')

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

roomManager.startGame(hostId, 'language')

const publicState = roomManager.getGamePublicState(room.id)
assert.equal(publicState.phase, 'dealing')
assert.equal(publicState.wordCategoryLabel, '美食')
assert.ok(!('wordPair' in publicState))
assert.ok(!('roles' in publicState))
assert.ok(!('playerWords' in publicState))

const reconnectSnapshot = roomManager.getReconnectGameSnapshot(room.id, guestAId)
assert.equal(reconnectSnapshot.wordCategoryLabel, '美食')
assert.ok(reconnectSnapshot.myWord)
assert.ok(!('wordPair' in reconnectSnapshot))
assert.ok(!('roles' in reconnectSnapshot))
assert.ok(!('playerWords' in reconnectSnapshot))

roomManager.destroyRoom(room.id)
