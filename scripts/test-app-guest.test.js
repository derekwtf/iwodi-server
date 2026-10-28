const test = require('node:test')
const assert = require('node:assert/strict')
const { createFixture, request } = require('./auth-fixture')
const { createTokenService, TOKEN_TTL_MS, REFRESH_TTL_MS } = require('../src/auth/tokens')
const { readAppPaymentConfig } = require('../src/payment/app-config')

const verifier = {
  requireProvider(provider) { assert.ok(['apple', 'google'].includes(provider)) },
  async verify({ provider, identityToken }) { return { provider, scope: 'guest-test', subject: identityToken } },
}
const options = { channel: 'app', appIdentityVerifier: verifier }
const login = (f, body) => f.login('', body, 'app-login')
const guest = (f) => login(f, { provider: 'guest', userId: 'caller', deviceId: 'caller', playerId: 'caller' })
const account = (f, subject, guestToken) => login(f, { provider: 'google', identityToken: subject, guestToken })
const handoff = (f, g, a) => login(f, { action: 'handoff', guestToken: g.token, accountToken: a.token })

// Cleanup plan: replace only forced App authorization and add purpose-separated refresh;
// keep all room, payment, deletion and WeChat entrypoints and their existing regressions.
test('guest creation and session recovery never invoke a platform verifier or trust caller identity', async () => {
  const f = await createFixture(':memory:', { ...options, appIdentityVerifier: { requireProvider() { throw new Error('platform invoked') } } })
  try {
    const g = await guest(f)
    assert.equal(g.status, 200)
    assert.equal(g.accountType, 'guest')
    assert.notEqual(g.userId, 'caller')
    assert.notEqual(g.playerId, 'caller')
    assert.ok(g.refreshExpiresAt > g.expiresAt)
    const resumed = await login(f, { refreshToken: g.refreshToken, userId: 'caller' })
    assert.equal(resumed.userId, g.userId)
    assert.equal(resumed.playerId, g.playerId)
    assert.equal(resumed.accountType, 'guest')
    const old = f.tokens.issue(g.userId)
    assert.ok((await login(f, { token: old.token })).refreshToken)
    const socket = await f.connect({ token: g.token })
    assert.equal(socket.accountType, 'guest')
    assert.equal((await request(socket.socket, 'room:create', { playMode: 'language' })).ok, true)
    await assert.rejects(f.connect({ token: g.refreshToken }), (error) => error.data.code === 'AUTH_INVALID')
    assert.equal((await login(f, { refreshToken: g.token })).error.code, 'AUTH_INVALID')
    const response = await fetch(`${f.url}/auth/account`, { method: 'DELETE', headers: { authorization: `Bearer ${g.refreshToken}`, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 401)
  } finally { await f.close() }
})

test('access expires at seven days; refresh has separate purpose and rolling 180-day validity', () => {
  let now = Date.now()
  const tokens = createTokenService('test-guest-purpose-secret-'.repeat(3), { now: () => now })
  const first = tokens.issueApp('user')
  assert.equal(first.expiresAt - now, TOKEN_TTL_MS)
  assert.equal(first.refreshExpiresAt - now, 180 * 86400000)
  assert.equal(REFRESH_TTL_MS, 180 * 86400000)
  assert.throws(() => tokens.verify(first.refreshToken), { code: 'AUTH_INVALID' })
  assert.throws(() => tokens.verifyRefresh(first.token), { code: 'AUTH_INVALID' })
  now = first.expiresAt
  assert.throws(() => tokens.verify(first.token), { code: 'AUTH_INVALID' })
  assert.equal(tokens.verifyRefresh(first.refreshToken).userId, 'user')
  const second = tokens.issueApp('user')
  assert.ok(second.refreshExpiresAt > first.refreshExpiresAt)
  now = first.refreshExpiresAt
  assert.throws(() => tokens.verifyRefresh(first.refreshToken), { code: 'AUTH_INVALID' })
  assert.equal(tokens.verifyRefresh(second.refreshToken).userId, 'user')
})

for (const existing of [false, true]) for (const host of [false, true]) for (const playing of [false, true]) {
  test(`handoff preserves ${existing ? 'existing' : 'new'} account / ${host ? 'host' : 'member'} / ${playing ? 'dealt' : 'waiting'} seat and cards`, async () => {
    const f = await createFixture(':memory:', options)
    try {
      const g = await guest(f)
      const before = existing ? await account(f, 'upgrade') : null
      if (before) f.userStore.updateProfile(before.userId, { nickname: 'Account', avatar: '/assets/avatars/avatar-3.svg' })
      f.userStore.updateProfile(g.userId, { nickname: 'Guest', avatar: '/assets/avatars/avatar-2.svg' })
      const peers = await Promise.all([guest(f), guest(f)])
      const credentials = host ? [g, ...peers] : [peers[0], g, peers[1]]
      const sockets = await Promise.all(credentials.map((c) => f.connect({ token: c.token, playerId: c.playerId })))
      const created = await request(sockets[0].socket, 'room:create', { playMode: 'language' })
      const roomId = created.room.roomId
      for (const socket of sockets.slice(1)) assert.equal((await request(socket.socket, 'room:join', { roomId })).ok, true)
      if (playing) assert.equal((await request(sockets[0].socket, 'room:startGame', { playMode: 'language' })).ok, true)
      const room = f.manager.rooms.get(roomId)
      const originalHost = room.players.find((p) => p.isHost).id
      const cards = playing ? JSON.stringify({ roles: room.gameState.roles, words: room.gameState.playerWords }) : null
      let departures = 0, transfers = 0
      f.manager.on('room:hostTransferred', () => transfers++)
      sockets[host ? 1 : 0].socket.on('room:playerLeft', () => departures++)
      const a = await account(f, 'upgrade', g.token)
      assert.equal(a.status, 200)
      assert.equal(a.accountType, 'account')
      assert.equal(a.profile.nickname, existing ? 'Account' : 'Guest')
      assert.equal(f.manager.getRoomIdForPlayer(g.playerId), roomId, 'phase one must not switch seat')
      const result = await handoff(f, g, a)
      assert.equal(result.status, 200)
      assert.equal(result.playerId, g.playerId)
      assert.equal(result.userId, a.userId)
      assert.equal(f.userStore.getUser(g.userId), null)
      assert.equal(f.manager.getRoomIdForPlayer(result.playerId), roomId)
      assert.equal(room.players.find((p) => p.isHost).id, originalHost)
      assert.equal((await handoff(f, g, a)).playerId, g.playerId, 'retry is idempotent')
      await assert.rejects(f.connect({ token: g.token, playerId: g.playerId }), (error) => error.data.code === 'AUTH_INVALID')
      assert.equal((await login(f, { refreshToken: g.refreshToken })).error.code, 'AUTH_INVALID')
      assert.equal((await f.connect({ token: result.token, playerId: result.playerId })).playerId, g.playerId)
      if (playing) {
        assert.equal(JSON.stringify({ roles: room.gameState.roles, words: room.gameState.playerWords }), cards)
        assert.equal(room.gameState.playerIdentities[g.playerId], a.userId)
      }
      assert.equal(departures, 0)
      assert.equal(transfers, 0)
      assert.deepEqual(f.userStore.db.pragma('foreign_key_check'), [])
    } finally { await f.close() }
  })
}

test('formal account holding another room seat blocks handoff without changing either identity', async () => {
  const f = await createFixture(':memory:', options)
  try {
    const g = await guest(f), original = await account(f, 'conflict')
    const gs = await f.connect({ token: g.token }), as = await f.connect({ token: original.token })
    const gr = await request(gs.socket, 'room:create'), ar = await request(as.socket, 'room:create')
    const a = await account(f, 'conflict', g.token)
    const rejected = await handoff(f, g, a)
    assert.equal(rejected.error.code, 'APP_ACCOUNT_IN_GAME')
    assert.equal(f.manager.getRoomIdForPlayer(g.playerId), gr.room.roomId)
    assert.equal(f.manager.getRoomIdForPlayer(original.playerId), ar.room.roomId)
    assert.ok(f.userStore.getUser(g.userId))
    assert.equal((await request(gs.socket, 'room:syncState')).ok, true)
    assert.equal((await handoff(f, g, original)).error.code, 'APP_HANDOFF_INVALID')
  } finally { await f.close() }
})

test('guest cleanup retains active room/socket users and formal accounts; touch and expiry use 180 days', async () => {
  const f = await createFixture(':memory:', options)
  try {
    const old = await guest(f), active = await guest(f), roomGuest = await guest(f), formal = await account(f, 'retained')
    const now = Date.now(), cutoff = now - 180 * 86400000
    f.userStore.db.prepare('UPDATE user_identities SET last_login_at = ?').run(cutoff)
    const socket = await f.connect({ token: active.token })
    const rs = await f.connect({ token: roomGuest.token })
    await request(rs.socket, 'room:create')
    // Model old timestamps even for connected users to verify active protection independently.
    f.userStore.db.prepare('UPDATE user_identities SET last_login_at = ?').run(cutoff)
    assert.equal(f.userStore.purgeInactiveGuests({ now, isActive: (id) => f.manager.hasActiveIdentity(id) }), 1)
    assert.equal(f.userStore.getUser(old.userId), null)
    assert.ok(f.userStore.getUser(active.userId))
    assert.ok(f.userStore.getUser(roomGuest.userId))
    assert.ok(f.userStore.getUser(formal.userId))
    assert.equal((await login(f, { refreshToken: old.refreshToken })).error.code, 'AUTH_INVALID')
    assert.equal((await login(f, { refreshToken: active.refreshToken })).status, 200)
    assert.ok(f.userStore.db.prepare('SELECT last_login_at AS time FROM user_identities WHERE user_id = ?').get(active.userId).time > cutoff)
    assert.ok(socket.socket.connected)
  } finally { await f.close() }
})

test('guest deletion skips platform revocation, remains idempotent, and prevents refresh resurrection', async () => {
  const f = await createFixture(':memory:', options)
  try {
    const g = await guest(f)
    const remove = () => fetch(`${f.url}/auth/account`, { method: 'DELETE', headers: { authorization: `Bearer ${g.token}`, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
    assert.deepEqual(await remove(), { deleted: true })
    assert.deepEqual(await remove(), { deleted: true })
    assert.equal((await login(f, { refreshToken: g.refreshToken })).error.code, 'AUTH_INVALID')
    assert.notEqual((await guest(f)).userId, g.userId)
  } finally { await f.close() }
})

test('guest cannot use any App purchase service or Socket entrypoint even with client account claims', async () => {
  const f = await createFixture(':memory:', { ...options, appPayment: { config: readAppPaymentConfig({}) } })
  try {
    const g = await guest(f), socket = await f.connect({ token: g.token })
    for (const method of ['create', 'queryOwn', 'restore', 'confirmPurchase']) {
      await assert.rejects(f.paymentService[method](g.userId, { accountType: 'account' }), { code: 'APP_ACCOUNT_REQUIRED' })
    }
    for (const event of ['user:createVipOrder', 'user:queryVipOrder', 'user:confirmVipPurchase']) {
      const result = await request(socket.socket, event, { accountType: 'account', restore: true })
      assert.equal(result.error.code, 'APP_ACCOUNT_REQUIRED')
    }
  } finally { await f.close() }
})

test('guest rate limit is 60 creations per IP per five minutes with bounded source buckets', async () => {
  const createHandler = require('../src/auth/createAppLoginHandler')
  let now = Date.now(), created = 0
  const handler = createHandler({ now: () => now, userStore: {
    createGuest: () => ({ userId: `guest-${++created}`, accountType: 'guest' }), touchSessionActivity() {},
  }, roomManager: { resolvePlayerIdByIdentity: (id) => id }, tokens: { issueApp: () => ({}) } })
  async function call(ip) {
    const result = { status: 200 }
    await handler({ ip, body: { provider: 'guest' } }, {
      status(value) { result.status = value; return this }, json(body) { Object.assign(result, body) },
    })
    return result
  }
  for (let i = 0; i < 60; i++) assert.equal((await call('source')).status, 200)
  assert.equal((await call('source')).status, 429)
  for (let i = 1; i < 1000; i++) assert.equal((await call(`source-${i}`)).status, 200)
  assert.equal((await call('overflow')).status, 429)
  assert.equal(created, 1059)
  now += 300000
  assert.equal((await call('source')).status, 200)
  assert.equal((await call('overflow')).status, 200)
})

test('handoff deletion failure preserves the guest connection and room; old callbacks fail after commit', async () => {
  const { requireActiveConnection } = require('../src/socket/helpers')
  const f = await createFixture(':memory:', options)
  try {
    const g = await guest(f), gs = await f.connect({ token: g.token })
    const room = await request(gs.socket, 'room:create')
    const a = await account(f, 'rollback', g.token)
    const oldSocket = f.io.sockets.sockets.get(gs.socket.id)
    f.userStore.db.exec("CREATE TRIGGER guest_delete_failure BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'failure'); END")
    assert.equal((await handoff(f, g, a)).error.code, 'USER_STORE_UNAVAILABLE')
    assert.ok(f.userStore.getUser(g.userId))
    assert.equal((await request(gs.socket, 'room:syncState')).room.roomId, room.room.roomId)
    f.userStore.db.exec('DROP TRIGGER guest_delete_failure')
    assert.equal((await handoff(f, g, a)).status, 200)
    assert.throws(() => requireActiveConnection(oldSocket, f.manager), { code: 'SESSION_REPLACED' })
    assert.equal(oldSocket.connected, false)
  } finally { await f.close() }
})

test('late platform verification cannot recreate or copy a guest that was deleted while awaiting proof', async () => {
  let release, entered
  const started = new Promise((resolve) => { entered = resolve })
  const proof = new Promise((resolve) => { release = resolve })
  const f = await createFixture(':memory:', { ...options, appIdentityVerifier: { ...verifier,
    verify: async (input) => { entered(); await proof; return verifier.verify(input) },
  } })
  try {
    const g = await guest(f)
    const pending = account(f, 'late', g.token)
    await started
    f.userStore.deleteAppUser(g.userId)
    release()
    assert.equal((await pending).error.code, 'AUTH_INVALID')
    assert.equal(f.userStore.db.prepare('SELECT count(*) n FROM users').get().n, 0)
  } finally { release(); await f.close() }
})

test('pending handoff recovers after seven-day access expiry and server restart without reviving a guest', async () => {
  const { mkdtempSync, rmSync } = require('node:fs')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  const directory = mkdtempSync(join(tmpdir(), 'wodi-guest-handoff-'))
  const filename = join(directory, 'users.sqlite')
  let f = await createFixture(filename, options)
  try {
    const g = await guest(f), a = await account(f, 'restart', g.token)
    const before = await handoff(f, g, a)
    assert.equal(before.playerId, g.playerId)
    await f.close()
    f = await createFixture(filename, options)
    // An expired old access token may establish the guest side of a signed binding
    // only; the formal account still authenticates with a fresh access credential.
    const expired = createTokenService('test-only-secret-'.repeat(4), { now: () => Date.now() - TOKEN_TTL_MS - 1000 }).issue(g.userId)
    const refreshed = await login(f, { refreshToken: a.refreshToken })
    assert.equal(refreshed.status, 200)
    const result = await handoff(f, { ...g, token: expired.token }, refreshed)
    assert.equal(result.status, 200)
    assert.equal(result.userId, a.userId)
    assert.equal((await handoff(f, g, refreshed)).playerId, result.playerId)
    assert.equal(f.userStore.getUser(g.userId), null)
    assert.equal((await login(f, { token: expired.token })).error.code, 'AUTH_INVALID')
    assert.equal((await login(f, { refreshToken: g.refreshToken })).error.code, 'AUTH_INVALID')
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('two phase-one accounts cannot both claim the same live guest seat', async () => {
  const f = await createFixture(':memory:', options)
  try {
    const g = await guest(f), gs = await f.connect({ token: g.token })
    await request(gs.socket, 'room:create')
    const a = await account(f, 'first', g.token), b = await account(f, 'second', g.token)
    assert.equal((await handoff(f, g, a)).status, 200)
    assert.equal((await handoff(f, g, b)).error.code, 'APP_HANDOFF_INVALID')
    assert.equal(f.manager.sessionRegistry.get(g.playerId).identityKey, a.userId)
  } finally { await f.close() }
})
