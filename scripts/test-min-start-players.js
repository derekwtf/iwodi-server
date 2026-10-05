const assert = require('node:assert/strict')
const RoomManager = require('../src/room/RoomManager')
const { getPlayRules } = require('../src/room/playMode')

for (const configured of [undefined, 2, '2', 3, 12, 'bad']) {
  const manager = new RoomManager({ minStartPlayers: configured })
  const playerId = manager.registerConnection({ socketId: 'host', identityKey: 'host' }).playerId
  const { room } = manager.createRoom({ playerId })
  assert.equal(manager.getRoomState(room.id).minStartPlayers, 3)
  manager.setPlayMode(playerId, 'body')
  assert.equal(manager.getRoomState(room.id).minStartPlayers, 3)
  manager.destroyRoom(room.id)
}
assert.deepEqual(getPlayRules('language'), { minPlayers: 3, maxPlayers: 12 })
assert.deepEqual(getPlayRules('body'), { minPlayers: 3, maxPlayers: 12 })
console.log('Product minimum player rules passed.')
