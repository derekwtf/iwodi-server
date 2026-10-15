const test = require('node:test')
const assert = require('node:assert/strict')
const { createFixture, request } = require('./auth-fixture')

async function setup() {
  const fixture = await createFixture(':memory:', { channel: 'app', appIdentityVerifier: {
    requireProvider(provider) { assert.equal(provider, 'google') },
    async verify({ identityToken }) { return { provider: 'google', scope: 'app.test', subject: identityToken, issuedAt: Date.now() } },
  } })
  const players = []
  for (const identityToken of ['alice', 'bob', 'charlie']) {
    const account = await fixture.login('', { provider: 'google', identityToken }, 'app-login')
    assert.equal(account.status, 200)
    players.push({ account, ...await fixture.connect({ token: account.token }) })
  }
  await request(players[0].socket, 'user:updateProfile', { nickname: 'DELETE-ME', avatar: '/assets/avatars/avatar-2.svg' })
  const room = (await request(players[0].socket, 'room:create', { playMode: 'language' })).room
  await request(players[1].socket, 'room:join', { roomId: room.roomId })
  await request(players[2].socket, 'room:join', { roomId: room.roomId })
  assert.equal((await request(players[0].socket, 'room:startGame', { playMode: 'language' })).ok, true)
  const remove = async (body = {}, token = players[0].account.token) => {
    const res = await fetch(`${fixture.url}/auth/account`, { method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  return { fixture, players, roomId: room.roomId, remove }
}

function event(socket, name, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`${name} timed out`)) }, 2000)
    const receive = (value) => { if (!matches(value)) return; clearTimeout(timer); socket.off(name, receive); resolve(value) }
    socket.on(name, receive)
  })
}

test('deleting an active host clears rooms, secrets and session ownership while guests retain their cards', async () => {
  const { fixture: f, players: [a, b], roomId, remove } = await setup()
  try {
    const original = f.manager.getReconnectGameSnapshot(roomId, b.playerId).myWord
    const before = f.manager.getGamePublicState(roomId)
    assert.ok(before.players.some((player) => player.nickname === 'DELETE-ME'))
    assert.equal(JSON.stringify(before).includes(a.account.userId), false)
    const left = event(b.socket, 'room:playerLeft')
    const disconnected = event(a.socket, 'disconnect')
    assert.deepEqual(await remove(), { status: 200, deleted: true })
    const notice = await left
    await disconnected
    assert.equal(notice.reason, 'account_deleted')
    assert.equal(notice.player.nickname, '已删除账号')
    assert.equal(f.userStore.getUser(a.account.userId), null)
    assert.equal(f.manager.sessionRegistry.get(a.playerId), null)
    assert.equal(f.manager.sessionRegistry.identityToPlayer.has(a.account.userId), false)
    const room = f.manager.getRoomState(roomId)
    assert.equal(room.playerCount, 2)
    assert.equal(room.players.filter((player) => player.isHost).length, 1)
    assert.equal(f.manager.getReconnectGameSnapshot(roomId, b.playerId).myWord, original)
    assert.equal(JSON.stringify(f.manager.rooms.get(roomId).gameState).includes('DELETE-ME'), false)
    assert.equal(JSON.stringify(f.manager.getGamePublicState(roomId)).includes(a.playerId), false)
    await assert.rejects(f.connect({ token: a.account.token }), { message: '登录已失效，请重新登录' })
    assert.deepEqual(await remove({ statusOnly: true }), { status: 200, deleted: true })
    assert.deepEqual(await remove(), { status: 200, deleted: true })
    const replay = await f.login('', { provider: 'google', identityToken: 'alice' }, 'app-login')
    assert.equal(replay.error.code, 'APP_REAUTH_REQUIRED')
  } finally { await f.close() }
})

test('deletion erases departed-player rosters even after the old in-memory session was swept', async () => {
  const { fixture: f, players: [a, b], roomId, remove } = await setup()
  try {
    await request(a.socket, 'room:leave')
    assert.ok(f.manager.getGamePublicState(roomId).players.some((player) => player.id === a.playerId && player.hasLeft))
    a.socket.close()
    f.manager.sessionRegistry.removeIdentity(a.account.userId)
    const synced = event(b.socket, 'game:stateSync', (game) => !game.players.some((player) => player.id === a.playerId))
    assert.deepEqual(await remove(), { status: 200, deleted: true })
    const game = await synced
    assert.equal(game.players.some((player) => player.id === a.playerId), false)
    assert.equal(JSON.stringify(f.manager.rooms.get(roomId).gameState).includes(a.account.userId), false)
    assert.equal(JSON.stringify(f.manager.rooms.get(roomId).gameState).includes('DELETE-ME'), false)
  } finally { await f.close() }
})
