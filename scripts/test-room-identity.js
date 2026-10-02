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

function connectIdentity(roomManager, identityKey, socketId) {
  const playerId = roomManager.resolvePlayerIdByIdentity(identityKey)
  roomManager.registerConnection({ playerId, socketId, identityKey })
  return playerId
}

function testSameIdentityReusesStablePlayerId() {
  const roomManager = createRoomManager()

  const firstPlayerId = roomManager.resolvePlayerIdByIdentity('wx:guest-openid')
  const secondPlayerId = roomManager.resolvePlayerIdByIdentity('wx:guest-openid')
  const anotherPlayerId = roomManager.resolvePlayerIdByIdentity('wx:another-openid')

  assert.strictEqual(secondPlayerId, firstPlayerId)
  assert.notStrictEqual(anotherPlayerId, firstPlayerId)
}

function testSameIdentityRejoinDoesNotCreateDuplicateRoomPlayer() {
  const roomManager = createRoomManager()
  const hostId = connectIdentity(roomManager, 'wx:host-openid', 'socket-host')
  const guestId = connectIdentity(roomManager, 'wx:guest-openid', 'socket-guest-1')

  const { room } = roomManager.createRoom({
    playerId: hostId,
    nickname: '房主',
    avatar: 'host.png',
  })

  roomManager.joinRoom(room.id, {
    playerId: guestId,
    nickname: '玩家甲',
    avatar: 'guest-a.png',
  })

  roomManager.markDisconnected('socket-guest-1')

  const recoveredGuestId = connectIdentity(
    roomManager,
    'wx:guest-openid',
    'socket-guest-2'
  )
  const joinResult = roomManager.joinRoom(room.id, {
    playerId: recoveredGuestId,
    nickname: '玩家甲',
    avatar: 'guest-a-new.png',
  })
  const roomState = roomManager.getRoomState(room.id)
  const guestPlayers = roomState.players.filter((player) => player.id === guestId)

  assert.strictEqual(recoveredGuestId, guestId)
  assert.strictEqual(joinResult.alreadyInRoom, true)
  assert.strictEqual(guestPlayers.length, 1)
  assert.strictEqual(guestPlayers[0].disconnected, false)
  assert.strictEqual(guestPlayers[0].avatar, 'guest-a-new.png')

  roomManager.destroyRoom(room.id)
}

function main() {
  testSameIdentityReusesStablePlayerId()
  testSameIdentityRejoinDoesNotCreateDuplicateRoomPlayer()
  console.log('Room identity test passed.')
}

main()
