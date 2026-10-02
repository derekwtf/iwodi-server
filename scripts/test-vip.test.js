const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const Database = require('better-sqlite3')
const UserStore = require('../src/user/UserStore')
const { resolveStoredProfile } = require('../src/user/profile')
const { createFixture, request } = require('./auth-fixture')

const normal = '/assets/avatars/avatar-3.svg'
const vip = '/assets/avatars/avatar-20.svg'
const identity = { provider: 'wechat_mini_program', scope: 'test-app', subject: 'verified-vip' }

function setExpiry(store, userId, value) {
  store.db.prepare('UPDATE users SET vip_expires_at = ? WHERE user_id = ?').run(value, userId)
}

function waitFor(socket, event, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, receive); reject(new Error(`${event} timeout`)) }, 2500)
    function receive(data) {
      if (!predicate(data)) return
      clearTimeout(timer)
      socket.off(event, receive)
      resolve(data)
    }
    socket.on(event, receive)
  })
}

test('old SQLite schema upgrades in place; legacy VIP-range avatars fall back without granting VIP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-vip-migration-'))
  const filename = join(dir, 'users.sqlite')
  const db = new Database(filename)
  db.exec(`CREATE TABLE users (user_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, avatar TEXT NOT NULL,
    last_normal_avatar TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run('old', '老玩家', vip, vip, 1, 1)
  db.close()
  const store = new UserStore(filename)
  try {
    const user = store.getUser('old')
    assert.equal(user.isVip, false)
    assert.equal(user.vipExpiresAt, 0)
    assert.equal(user.avatar, '/assets/avatars/avatar-1.svg')
    assert.equal(user.lastNormalAvatar, user.avatar)
    assert.equal(store.db.prepare('SELECT avatar FROM users WHERE user_id = ?').get('old').avatar, user.avatar)
    assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('VIP persistence, strict expiration boundary, normal-avatar recovery and failed saves are atomic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-vip-'))
  const filename = join(dir, 'users.sqlite')
  let store = new UserStore(filename)
  try {
    let user = store.findOrCreate(identity)
    store.updateProfile(user.userId, { nickname: '会员', avatar: normal })
    assert.throws(() => store.updateProfile(user.userId, { nickname: '伪造', avatar: vip, isVip: true }), { code: 'INVALID_AVATAR' })
    const expiry = Date.now() + 60000
    setExpiry(store, user.userId, expiry)
    user = store.updateProfile(user.userId, { nickname: '会员', avatar: vip })
    assert.equal(user.lastNormalAvatar, normal)
    assert.equal(resolveStoredProfile(user, expiry - 1).isVip, true)
    assert.equal(resolveStoredProfile(user, expiry).isVip, false)
    assert.equal(resolveStoredProfile(user, expiry).avatar, normal)
    store.close()
    store = new UserStore(filename)
    assert.deepEqual(store.findOrCreate(identity), user)
    store.db.exec("CREATE TRIGGER fail_profile BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'test'); END")
    assert.throws(() => store.updateProfile(user.userId, { nickname: '失败', avatar: normal }), { code: 'USER_STORE_UNAVAILABLE' })
    assert.deepEqual(store.getUser(user.userId), user)
    store.db.exec('DROP TRIGGER fail_profile')
    store.updateProfile(user.userId, { nickname: '会员', avatar: '/assets/avatars/avatar-8.svg' })
    store.updateProfile(user.userId, { nickname: '会员', avatar: vip })
    setExpiry(store, user.userId, Date.now() - 1)
    assert.equal(store.getUser(user.userId).avatar, '/assets/avatars/avatar-8.svg')
    assert.throws(() => store.updateProfile(user.userId, { nickname: '重放', avatar: vip }), { code: 'INVALID_AVATAR' })
  } finally { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('private state, forged claims, outside-room editing, room broadcast, expiry and reconnection', async () => {
  const f = await createFixture()
  try {
    const account = await f.login('vip')
    const ordinary = await f.login('ordinary')
    const stranger = await f.connect({ token: ordinary.token, playerId: account.playerId, isVip: true })
    const forged = await request(stranger.socket, 'user:updateProfile', { nickname: '伪造', avatar: vip,
      userId: account.userId, vipExpiresAt: Date.now() + 999999, isVip: true })
    assert.equal(forged.ok, false)
    const own = await request(stranger.socket, 'user:syncState', { userId: account.userId })
    assert.equal(own.userId, ordinary.userId)
    assert.equal(own.membership.availableAvatars.length, 8)
    assert.equal(own.membership.purchasable, false)
    f.userStore.updateProfile(account.userId, { nickname: '会员', avatar: normal })
    const expiresAt = Date.now() + 1200
    setExpiry(f.userStore, account.userId, expiresAt)
    const host = await f.connect({ token: account.token })
    assert.equal(host.membership.isVip, true)
    assert.equal(host.membership.vipExpiresAt, expiresAt)
    assert.equal(host.membership.availableAvatars.length, 20)
    const saved = await request(host.socket, 'user:updateProfile', { nickname: '会员', avatar: vip })
    assert.equal(saved.ok, true)
    const created = await request(host.socket, 'room:create', { gameMode: 'deal-only' })
    const roomId = created.room.roomId
    const joined = await request(stranger.socket, 'room:join', { roomId, avatar: vip, isVip: true })
    assert.equal(joined.room.players[0].isVip, true)
    assert.equal(joined.room.players[0].isHost, true)
    assert.equal(joined.room.players[1].isVip, false)
    const publicJson = JSON.stringify(joined.room)
    for (const secret of [account.userId, 'verified-vip', 'vipExpiresAt', 'lastNormalAvatar', account.token]) {
      assert.equal(publicJson.includes(secret), false)
    }
    await request(host.socket, 'room:startGame')
    const oldActivity = f.manager.rooms.get(roomId).lastActivityAt
    const expiredRoom = waitFor(stranger.socket, 'room:state', (data) => !data.room.players[0].isVip)
    const expiredSelf = waitFor(host.socket, 'user:state', (data) => data.membership?.isVip === false)
    const [room, self] = await Promise.all([expiredRoom, expiredSelf])
    assert.equal(room.room.players[0].avatar, normal)
    assert.equal(self.profile.avatar, normal)
    assert.equal(f.manager.rooms.get(roomId).lastActivityAt, oldActivity, 'background account refresh must not keep idle rooms alive')
    assert.equal(f.manager.getGamePublicState(roomId).players[0].isVip, false)
    assert.equal(f.userStore.getUser(account.userId).avatar, normal)
    const reconnected = await f.connect({ token: account.token })
    assert.equal(reconnected.profile.avatar, normal)
    assert.equal(reconnected.membership.vipExpiresAt, expiresAt)
    assert.equal((await request(reconnected.socket, 'room:updateProfile', { nickname: '重放', avatar: vip })).ok, false)
    assert.equal((await f.login('vip')).membership.isVip, false)
  } finally { await f.close() }
})

test('revocation and normal-avatar VIPs synchronize without changing the room or game', async () => {
  const f = await createFixture()
  try {
    const account = await f.login('vip')
    setExpiry(f.userStore, account.userId, Date.now() + 60000)
    const host = await f.connect({ token: account.token })
    const created = await request(host.socket, 'room:create', { gameMode: 'deal-only' })
    assert.equal(created.room.players[0].isVip, true)
    setExpiry(f.userStore, account.userId, 0)
    const synced = await request(host.socket, 'user:syncState')
    assert.equal(synced.membership.isVip, false)
    assert.equal(synced.profile.avatar, account.profile.avatar)
    assert.equal(synced.room.roomId, created.room.roomId)
    assert.equal(synced.room.players[0].isVip, false)
  } finally { await f.close() }
})

test('database failure at expiry removes cached VIP appearance and reports unconfirmed membership', async () => {
  const f = await createFixture()
  try {
    const account = await f.login('vip')
    f.userStore.updateProfile(account.userId, { nickname: '会员', avatar: normal })
    setExpiry(f.userStore, account.userId, Date.now() + 300)
    f.userStore.updateProfile(account.userId, { nickname: '会员', avatar: vip })
    const host = await f.connect({ token: account.token })
    const created = await request(host.socket, 'room:create', { gameMode: 'deal-only' })
    const fallback = waitFor(host.socket, 'user:state', (data) => Boolean(data.error))
    f.userStore.close()
    const result = await fallback
    assert.equal(result.profile.avatar, normal)
    assert.equal(result.membership.isVip, false)
    assert.equal(f.manager.getRoomState(created.room.roomId).players[0].isVip, false)
    assert.equal((await request(host.socket, 'room:create', { gameMode: 'deal-only' })).ok, true)
  } finally { await f.close() }
})

for (const event of ['user:updateProfile', 'room:updateProfile']) {
  test(`${event} returns the private snapshot and broadcasts the saved room and game once`, async () => {
    const f = await createFixture()
    try {
      const account = await f.login('vip-ack')
      const expiry = Date.now() + 60000
      setExpiry(f.userStore, account.userId, expiry)
      const host = await f.connect({ token: account.token })
      const guestAccount = await f.login('observer')
      const guest = await f.connect({ token: guestAccount.token })
      const created = await request(host.socket, 'room:create', { gameMode: 'deal-only' })
      await request(guest.socket, 'room:join', { roomId: created.room.roomId })
      await request(host.socket, 'room:startGame')
      const states = [], rooms = [], games = [], guestStates = []
      host.socket.on('user:state', (data) => states.push(data))
      host.socket.on('room:state', (data) => rooms.push(data.room))
      host.socket.on('game:stateSync', (data) => games.push(data))
      guest.socket.on('user:state', (data) => guestStates.push(data))
      const publicUpdate = waitFor(guest.socket, 'room:state', (data) => data.room.players[0].avatar === vip)
      const before = Date.now()
      const saved = await request(host.socket, event, { nickname: '  会员  ', avatar: vip })
      const observed = await publicUpdate
      assert.equal(saved.ok, true)
      assert.equal(saved.userId, account.userId)
      assert.deepEqual(saved.profile, { nickname: '会员', avatar: vip })
      assert.equal(saved.membership.isVip, true)
      assert.equal(saved.membership.vipExpiresAt, expiry)
      assert.equal(saved.membership.availableAvatars.length, 20)
      assert.ok(saved.membership.serverTime >= before && saved.membership.serverTime <= Date.now())
      assert.deepEqual(states, [{ userId: saved.userId, profile: saved.profile, membership: saved.membership }])
      assert.deepEqual(rooms, [saved.room])
      assert.deepEqual(games, [saved.gameState])
      assert.equal(observed.room.players[0].avatar, vip)
      assert.equal(JSON.stringify(observed).includes(account.userId), false)
      assert.deepEqual(guestStates, [])
    } finally { await f.close() }
  })
}
