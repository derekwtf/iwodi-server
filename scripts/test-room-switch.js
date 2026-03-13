/* eslint-disable no-console */
const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')

function registerPlayer(roomManager, socketId) {
  const connection = roomManager.registerConnection({ socketId })
  return connection.playerId
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

function main() {
  const roomManager = new RoomManager()
  const hostAId = registerPlayer(roomManager, 'socket-host-a')
  const guestAId = registerPlayer(roomManager, 'socket-guest-a')
  const hostBId = registerPlayer(roomManager, 'socket-host-b')

  const roomAId = createRoom(roomManager, hostAId, '房主甲')
  joinRoom(roomManager, roomAId, guestAId, '玩家甲')
  const roomBId = createRoom(roomManager, hostBId, '房主乙')

  const switched = joinRoom(roomManager, roomBId, hostAId, '房主甲')

  assert.ok(switched.previousRoomResult, '切房时应返回旧房间结果')
  assert.strictEqual(switched.previousRoomResult.roomId, roomAId)
  assert.strictEqual(switched.previousRoomResult.reason, 'switch_room')
  assert.strictEqual(switched.previousRoomResult.removedPlayer.id, hostAId)
  assert.ok(switched.previousRoomResult.hostChanged, '旧房主离开后应转移房主')
  assert.strictEqual(switched.previousRoomResult.hostChanged.id, guestAId)

  const roomAState = roomManager.getRoomState(roomAId)
  const roomBState = roomManager.getRoomState(roomBId)

  assert.ok(roomAState, '旧房间仍有玩家时不应销毁')
  assert.strictEqual(roomAState.playerCount, 1)
  assert.strictEqual(roomAState.players[0].id, guestAId)
  assert.strictEqual(roomAState.players[0].isHost, true)

  assert.ok(roomBState, '新房间应存在')
  assert.strictEqual(roomBState.playerCount, 2)
  assert.strictEqual(roomBState.players.some((player) => player.id === hostAId), true)
  assert.strictEqual(roomBState.players.some((player) => player.id === hostBId), true)

  assert.strictEqual(roomManager.getRoomIdForPlayer(hostAId), roomBId)
  assert.strictEqual(roomManager.getRoomIdForPlayer(guestAId), roomAId)

  console.log('Room switch test passed.')
}

main()
