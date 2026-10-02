const assert = require('assert/strict')
const { test } = require('node:test')
const { mkdtempSync, rmSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { spawnSync } = require('child_process')
const { createHmac } = require('crypto')
const UserStore = require('../src/user/UserStore')
const SessionRegistry = require('../src/room/SessionRegistry')
const { createTokenService, TOKEN_TTL_MS } = require('../src/auth/tokens')
const { createFixture, request } = require('./auth-fixture')
const profile = { nickname: '新昵称', avatar: '/assets/avatars/avatar-32.svg' }

function identity(subject, scope = 'app', provider = 'wechat_mini_program') {
  return { provider, scope, subject }
}

test('SQLite: identity isolation, rollback, normalized profile, reopen and online backup restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-users-'))
  const path = join(dir, 'users.sqlite')
  let store = new UserStore(path)
  try {
    const first = store.findOrCreate(identity('one'))
    assert.equal(store.findOrCreate(identity('one')).userId, first.userId)
    assert.notEqual(store.findOrCreate(identity('one', 'other-app')).userId, first.userId)
    assert.notEqual(store.findOrCreate(identity('one', 'app', 'other-provider')).userId, first.userId)
    assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1)
    assert.throws(() => store.db.prepare('INSERT INTO user_identities VALUES (?, ?, ?, ?, ?, ?)')
      .run('missing', 'p', 's', 'subject', 1, 1), /FOREIGN KEY/)
    store.db.exec("CREATE TRIGGER fail_identity BEFORE INSERT ON user_identities BEGIN SELECT RAISE(ABORT, 'test'); END")
    assert.throws(() => store.findOrCreate(identity('fail')), { code: 'USER_STORE_UNAVAILABLE' })
    assert.equal(store.db.prepare('SELECT count(*) n FROM users').get().n, 3)
    store.db.exec('DROP TRIGGER fail_identity')
    const normalized = store.updateProfile(first.userId, { ...profile, nickname: '  ' + '名'.repeat(25) + '  ' })
    assert.equal(normalized.nickname, '名'.repeat(20))
    assert.equal(store.db.prepare('SELECT last_normal_avatar FROM users WHERE user_id = ?').get(first.userId).last_normal_avatar, profile.avatar)
    assert.throws(() => store.updateProfile(first.userId, { ...profile, nickname: '   ' }), { code: 'INVALID_NICKNAME' })
    for (const avatar of ['https://example.com/a.png', '/assets/avatars/avatar-33.svg', '/assets/avatars/avatar-01.svg', '/assets/avatars/agent-vip.svg', '']) {
      assert.throws(() => store.updateProfile(first.userId, { ...profile, avatar }), { code: 'INVALID_AVATAR' })
    }
    const before = store.db.prepare('SELECT updated_at FROM users WHERE user_id = ?').get(first.userId)
    store.findOrCreate(identity('one'))
    assert.deepEqual(store.db.prepare('SELECT updated_at FROM users WHERE user_id = ?').get(first.userId), before)
    await store.db.backup(join(dir, 'backup.sqlite'))
    store.close()
    store = new UserStore(path)
    assert.deepEqual(store.getUser(first.userId), { userId: first.userId, ...normalized })
    const restored = new UserStore(join(dir, 'backup.sqlite'))
    assert.equal(restored.db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(restored.db.pragma('foreign_key_check'), [])
    assert.deepEqual(restored.findOrCreate(identity('one')), store.getUser(first.userId))
    restored.close()
  } finally { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('HMAC rejects missing, tampered and expired tokens; registry requires identity and cannot claim unowned IDs', () => {
  const secret = 's'.repeat(32)
  const tokens = createTokenService(secret)
  assert.throws(() => createTokenService(''), /AUTH_TOKEN_SECRET/)
  const issued = tokens.issue('user')
  assert.equal(tokens.verify(issued.token).userId, 'user')
  assert.ok(Math.abs(issued.expiresAt - Date.now() - TOKEN_TTL_MS) < 1000)
  const body = Buffer.from(JSON.stringify({ userId: 'user', expiresAt: Date.now() - 1 })).toString('base64url')
  const expired = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
  for (const token of [undefined, '', issued.token + 'x', expired, issued.token + '.extra']) {
    assert.throws(() => tokens.verify(token), { code: 'AUTH_INVALID' })
  }
  const registry = new SessionRegistry()
  assert.throws(() => registry.registerConnection({ socketId: 'anon' }), { code: 'IDENTITY_REQUIRED' })
  registry.sessions.set('legacy', { playerId: 'legacy', identityKey: '' })
  assert.notEqual(registry.resolvePlayerIdByIdentity('new-user', 'legacy'), 'legacy')
  const victim = registry.resolvePlayerIdByIdentity('victim')
  assert.notEqual(registry.registerConnection({ identityKey: 'attacker', playerId: victim, socketId: 'attacker' }).session.playerId, victim)
  clearInterval(registry.sweepTimer)
})

test('Socket authentication, private identity, profile persistence, membership and replacement', async () => {
  const f = await createFixture()
  try {
    const a = await f.login('a')
    const b = await f.login('b')
    const expiredBody = Buffer.from(JSON.stringify({ userId: a.userId, expiresAt: Date.now() - 1 })).toString('base64url')
    const expired = `${expiredBody}.${createHmac('sha256', 'test-only-secret-'.repeat(4)).update(expiredBody).digest('base64url')}`
    for (const auth of [{}, { playerId: a.playerId }, { token: expired }, { token: a.token + 'x' }, { token: f.tokens.issue('missing-user').token }]) {
      await assert.rejects(f.connect(auth), (error) => error.data.code === 'AUTH_INVALID')
    }
    await assert.rejects(f.connect({}, { query: { playerId: a.playerId, token: a.token } }), (error) => error.data.code === 'AUTH_INVALID')
    const host = await f.connect({ token: a.token, playerId: a.playerId })
    const initial = await request(host.socket, 'room:create', { nickname: 'fake', avatar: 'fake', gameMode: 'deal-only' })
    assert.equal(initial.room.players[0].nickname, a.profile.nickname)
    const attacker = await f.connect({ token: b.token, playerId: a.playerId })
    assert.equal(attacker.playerId, b.playerId)
    assert.equal(f.manager.getRoomIdForPlayer(attacker.playerId), null)
    assert.equal(host.socket.connected, true)
    assert.equal((await request(attacker.socket, 'room:updateProfile', profile)).ok, false)
    assert.deepEqual(f.userStore.getUser(b.userId), { userId: b.userId, ...b.profile })
    await request(attacker.socket, 'room:join', { roomId: initial.room.roomId, nickname: 'fake', avatar: 'fake' })
    const start = await request(host.socket, 'room:startGame')
    assert.equal(start.ok, true)
    const saved = await request(host.socket, 'room:updateProfile', { ...profile, nickname: '  新昵称  ' })
    assert.equal(saved.player.nickname, profile.nickname)
    assert.equal(saved.gameState.players.find((player) => player.id === a.playerId).avatar, profile.avatar)
    assert.deepEqual((await f.login('a')).profile, profile)
    assert.equal(JSON.stringify(saved).includes(a.userId), false)
    assert.equal(JSON.stringify(saved).includes(a.token), false)
    assert.equal(JSON.stringify(saved).includes('verified-a'), false)
    for (const invalid of [{ ...profile, nickname: ' ' }, { ...profile, avatar: 'https://bad' }]) {
      assert.equal((await request(host.socket, 'room:updateProfile', invalid)).ok, false)
    }
    f.userStore.db.exec("CREATE TRIGGER fail_profile BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'test'); END")
    const failed = await request(host.socket, 'room:updateProfile', { ...profile, nickname: '不应保存' })
    assert.equal(failed.error.code, 'USER_STORE_UNAVAILABLE')
    assert.equal(f.manager.getRoomState(initial.room.roomId).players[0].nickname, profile.nickname)
    f.userStore.db.exec('DROP TRIGGER fail_profile')
    // 重连前的资料可能由另一个连接更新，房间和游戏快照必须用握手时的版本。
    f.userStore.updateProfile(a.userId, { ...profile, nickname: '重连资料' })
    const replacement = await f.connect({ token: a.token, playerId: a.playerId })
    assert.equal(replacement.profile.nickname, '重连资料')
    assert.equal(f.manager.getReconnectGameSnapshot(initial.room.roomId, a.playerId).players[0].nickname, '重连资料')
    await request(replacement.socket, 'room:updateProfile', profile)
    const switched = await request(replacement.socket, 'room:create', { nickname: 'fake' })
    assert.equal(switched.room.players[0].nickname, profile.nickname)
    await request(attacker.socket, 'room:join', { roomId: switched.room.roomId })
    await request(replacement.socket, 'room:kickPlayer', { playerId: b.playerId })
    assert.equal((await request(attacker.socket, 'room:updateProfile', profile)).ok, false)
    await request(replacement.socket, 'room:leave')
    assert.equal((await request(replacement.socket, 'room:updateProfile', profile)).ok, false)
    await request(replacement.socket, 'room:create')
    f.manager.closeRoom(f.manager.getRoomIdForPlayer(a.playerId))
    assert.equal((await request(replacement.socket, 'room:updateProfile', profile)).ok, false)
    // 模拟旧连接已排队的事件：活动连接校验必须在事件执行前拦截。
    f.manager.registerConnection({ identityKey: a.userId, playerId: a.playerId, socketId: 'replacement' })
    assert.equal((await request(replacement.socket, 'room:create')).error.code, 'SESSION_REPLACED')
  } finally { await f.close() }
})

test('Runtime database failure rejects login/connect/save while existing ordinary play continues', async () => {
  const f = await createFixture()
  try {
    const a = await f.login('a'), b = await f.login('b')
    const host = await f.connect({ token: a.token }), guest = await f.connect({ token: b.token })
    const room = await request(host.socket, 'room:create', { gameMode: 'deal-only' })
    await request(guest.socket, 'room:join', { roomId: room.room.roomId })
    f.userStore.close()
    assert.equal((await f.login('new')).status, 503)
    await assert.rejects(f.connect({ token: a.token }), (error) => error.data.code === 'USER_STORE_UNAVAILABLE')
    assert.equal((await request(host.socket, 'room:updateProfile', profile)).error.code, 'USER_STORE_UNAVAILABLE')
    assert.equal(f.manager.getRoomState(room.room.roomId).players[0].nickname, a.profile.nickname)
    assert.equal((await request(host.socket, 'room:startGame')).ok, true)
    assert.equal((await request(host.socket, 'game:restart')).ok, true)
    assert.equal((await request(host.socket, 'room:create')).room.players[0].nickname, a.profile.nickname)
  } finally { await f.close() }
})

test('Service restart restores account and token but no room or old player session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-restart-'))
  let f = await createFixture(join(dir, 'users.sqlite'))
  try {
    const first = await f.login('restart')
    const host = await f.connect({ token: first.token })
    const room = await request(host.socket, 'room:create', { gameMode: 'deal-only' })
    await request(host.socket, 'room:updateProfile', profile)
    await f.close()
    f = await createFixture(join(dir, 'users.sqlite'))
    const connection = await f.connect({ token: first.token, playerId: first.playerId })
    assert.equal(connection.userId, first.userId)
    assert.notEqual(connection.playerId, first.playerId)
    assert.deepEqual(connection.profile, profile)
    assert.equal(f.manager.getRoomState(room.room.roomId), null)
    assert.equal((await f.login('restart')).userId, first.userId)
    assert.equal((await request(connection.socket, 'room:create')).ok, true)
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('Startup refuses missing secret or inaccessible database before listening; Node 22 backup command restores data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-startup-'))
  try {
    for (const config of [
      { AUTH_TOKEN_SECRET: '', USER_DB_PATH: join(dir, 'users.sqlite') },
      { AUTH_TOKEN_SECRET: 's'.repeat(32), USER_DB_PATH: join(dir, 'missing', 'users.sqlite') },
    ]) {
      const child = spawnSync(process.execPath, [join(__dirname, '../src/index.js')], {
        env: { ...process.env, ...config, HOST: '127.0.0.1', PORT: '0' }, encoding: 'utf8', timeout: 3000,
      })
      assert.notEqual(child.status, 0)
      assert.equal(child.stdout.includes('listening'), false)
    }
    const store = new UserStore(join(dir, 'users.sqlite'))
    const user = store.findOrCreate(identity('backup'))
    const backup = join(dir, 'backup.sqlite')
    const child = spawnSync(process.execPath, [join(__dirname, 'backup-users.js'), backup], {
      env: { ...process.env, USER_DB_PATH: join(dir, 'users.sqlite') }, encoding: 'utf8', timeout: 3000,
    })
    store.close()
    assert.equal(child.status, 0, child.stderr)
    const restored = new UserStore(backup)
    assert.deepEqual(restored.getUser(user.userId), user)
    restored.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Node 22 entrypoint starts with initialized database and health endpoint', async () => {
  const { spawn } = require('child_process')
  const dir = mkdtempSync(join(tmpdir(), 'wodi-entry-'))
  const child = spawn(process.execPath, [join(__dirname, '../src/index.js')], {
    env: { ...process.env, USER_DB_PATH: join(dir, 'users.sqlite'), AUTH_TOKEN_SECRET: 's'.repeat(32),
      WECHAT_APP_ID: 'test-app', WECHAT_APP_SECRET: 'test-secret', HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stopped = new Promise((resolve) => child.once('exit', resolve))
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup timed out')), 3000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('startup exited')) })
      child.stdout.on('data', (data) => {
        const match = String(data).match(/listening on (http:\/\/[^\s]+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
    })
    const health = await (await fetch(`${url}/health`)).json()
    assert.equal(health.status, 'ok')
    assert.equal(health.auth.wechatLoginConfigured, true)
  } finally {
    child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  }
})
