const test = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign } = require('node:crypto')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { createAppIdentityVerifier } = require('../src/auth/createAppIdentityVerifier')
const { createFixture, request } = require('./auth-fixture')

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }
const audience = { apple: 'test.app.bundle', google: 'test-web-client.apps.googleusercontent.com' }

function proof(provider, claims = {}, header = {}, key = privateKey) {
  const time = Math.floor(Date.now() / 1000)
  const body = [
    { alg: 'RS256', kid: jwk.kid, ...header },
    { iss: provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com',
      aud: audience[provider], sub: 'platform-user', exp: time + 3600, iat: time, ...claims },
  ].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`
}

function verifier(options = {}) {
  return createAppIdentityVerifier({ appleClientId: audience.apple, googleClientId: audience.google,
    fetchKeys: async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=3600' } }),
    ...options })
}

test('App proofs verify signatures, provider scope and claims without trusting caller identity', async () => {
  const verify = verifier().verify
  const time = Math.floor(Date.now() / 1000)
  const timestamps = { iat: time, exp: time + 3600 }
  const verifiedTimes = { issuedAt: time * 1000, expiresAt: (time + 3600) * 1000 }
  assert.deepEqual(await verify({ provider: 'apple', nonce: 'challenge', identityToken: proof('apple', { nonce: 'challenge', ...timestamps }) }),
    { provider: 'apple', scope: audience.apple, subject: 'platform-user', ...verifiedTimes })
  for (const issuer of ['https://accounts.google.com', 'accounts.google.com']) {
    assert.deepEqual(await verify({ provider: 'google', identityToken: proof('google', { iss: issuer, ...timestamps }) }),
      { provider: 'google', scope: audience.google, subject: 'platform-user', ...verifiedTimes })
  }
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  for (const identityToken of [
    '', 'broken', proof('google') + '.extra', proof('google') + 'x',
    proof('google', {}, {}, otherKey), proof('google', {}, { alg: 'HS256' }), proof('google', {}, { kid: 'unknown' }),
    proof('google', { iss: 'https://attacker.example' }), proof('google', { aud: 'other-app' }),
    proof('google', { aud: [audience.google, 'other-app'] }), proof('google', { sub: '' }),
    proof('google', { exp: time }), proof('google', { iat: time + 120 }), proof('google', { nbf: time + 120 }),
    proof('google', { exp: String(time + 3600) }), proof('google', { iat: undefined }),
    proof('google', { iat: 0 }), proof('google', { exp: Number.MAX_SAFE_INTEGER }),
    proof('apple', { nonce: 'challenge' }),
  ]) await assert.rejects(verify({ provider: 'google', identityToken }), { code: 'APP_PROOF_INVALID' })
  for (const nonce of [undefined, '', 'different']) {
    await assert.rejects(verify({ provider: 'apple', nonce, identityToken: proof('apple', { nonce: 'challenge' }) }),
      { code: 'APP_PROOF_INVALID' })
  }
  await assert.rejects(verify({ provider: 'wechat', identityToken: proof('google') }), { code: 'APP_PROVIDER_INVALID' })
  await assert.rejects(createAppIdentityVerifier().verify({ provider: 'google', identityToken: proof('google') }),
    { code: 'APP_LOGIN_NOT_CONFIGURED' })
})

test('JWKS requests are deduplicated, bounded, cached, rotated and unavailable keys fail closed', async () => {
  let count = 0, currentTime = Date.now()
  const keys = [jwk]
  const v = verifier({ now: () => currentTime, fetchKeys: async (url, options) => {
    count += 1
    assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs')
    assert.ok(options.signal instanceof AbortSignal)
    return new Response(JSON.stringify({ keys }), { headers: { 'cache-control': 'max-age=3600' } })
  } })
  await Promise.all(Array.from({ length: 12 }, () => v.verify({ provider: 'google', identityToken: proof('google') })))
  assert.equal(count, 1)
  await assert.rejects(v.verify({ provider: 'google', identityToken: proof('google', {}, { kid: 'rotated' }) }),
    { code: 'APP_PROOF_INVALID' })
  assert.equal(count, 1)
  currentTime += 61_000
  keys.push({ ...jwk, kid: 'rotated' })
  await v.verify({ provider: 'google', identityToken: proof('google', {}, { kid: 'rotated' }) })
  assert.equal(count, 2)
  for (const fetchKeys of [async () => { throw new Error('network') }, async () => new Response('{}'),
    async () => new Response('', { status: 503 }), async () => new Response('{')]) {
    await assert.rejects(verifier({ fetchKeys }).verify({ provider: 'google', identityToken: proof('google') }),
      { code: 'APP_LOGIN_UNAVAILABLE', statusCode: 503 })
  }
  currentTime = Date.now()
  const expiresDuringFetch = verifier({ now: () => currentTime, fetchKeys: async () => {
    currentTime += 2000
    return new Response(JSON.stringify({ keys: [jwk] }))
  } })
  await assert.rejects(expiresDuringFetch.verify({ provider: 'google',
    identityToken: proof('google', { exp: Math.floor(currentTime / 1000) + 1 }) }), { code: 'APP_PROOF_INVALID' })
})

test('App route uses one-time Apple challenges and verified identities; existing Socket accepts issued tokens', async () => {
  const f = await createFixture(':memory:', { channel: 'app', appIdentityVerifier: verifier() })
  const login = (body) => f.login('', body, 'app-login')
  try {
    assert.equal((await fetch(`${f.url}/auth/wechat-login`, { method: 'POST' })).status, 404)
    assert.equal((await fetch(`${f.url}/auth/login`, { method: 'POST' })).status, 404)
    const challenge = await login({ provider: 'apple' })
    assert.equal(challenge.status, 200)
    assert.match(challenge.nonce, /^[A-Za-z0-9_-]{43}$/)
    assert.ok(challenge.expiresAt > Date.now())
    const body = { provider: 'apple', identityToken: proof('apple', { nonce: challenge.nonce }), nonce: challenge.nonce,
      userId: 'fake', email: 'fake@example.com', nickname: 'fake' }
    const attempts = await Promise.all([login(body), login(body)])
    const success = attempts.find((result) => result.status === 200)
    assert.ok(success)
    assert.equal(attempts.filter((result) => result.error?.code === 'APP_NONCE_INVALID').length, 1)
    assert.notEqual(success.userId, 'fake')
    assert.match(success.profile.nickname, /^玩家\d{4}$/)
    assert.equal(success.membership.purchasable, false)
    assert.equal(f.tokens.verify(success.token).userId, success.userId)
    assert.equal((await login(body)).error.code, 'APP_NONCE_INVALID')
    assert.equal((await login({ provider: 'apple', identityToken: proof('apple') })).error.code, 'APP_NONCE_INVALID')
    const google = await login({ provider: 'google', identityToken: proof('google'), playerId: success.playerId,
      email: 'fake@example.com', userId: success.userId })
    assert.equal(google.status, 200)
    assert.notEqual(google.userId, success.userId)
    assert.notEqual(google.playerId, success.playerId)
    const again = await login({ provider: 'google', identityToken: proof('google') })
    assert.equal(again.userId, google.userId)
    assert.equal(again.playerId, google.playerId)
    assert.equal(f.userStore.db.prepare('SELECT count(*) n FROM users').get().n, 2)
    const client = await f.connect({ token: success.token, playerId: success.playerId })
    assert.equal(client.userId, success.userId)
    assert.equal((await request(client.socket, 'room:create', { playMode: 'language' })).ok, true)
    await assert.rejects(f.connect({ userId: success.userId, playerId: success.playerId }),
      (error) => error.data.code === 'AUTH_INVALID')
    assert.equal((await login({ provider: 'google', userId: success.userId })).error.code, 'APP_PROOF_REQUIRED')
  } finally { await f.close() }
})

test('Apple challenges expire, are bounded per source and are not consumed by invalid proofs', async () => {
  const createAppLoginHandler = require('../src/auth/createAppLoginHandler')
  let time = Date.now()
  const handler = createAppLoginHandler({ appIdentityVerifier: verifier(), now: () => time,
    userStore: { findOrCreate: () => { throw new Error('must not create account') } } })
  async function call(body) {
    const result = { status: 200 }
    await handler({ body, ip: '127.0.0.1' }, {
      status(value) { result.status = value; return this }, json(body) { Object.assign(result, body) },
    })
    return result
  }
  const challenge = await call({ provider: 'apple' })
  assert.equal((await call({ provider: 'apple', identityToken: proof('apple', { nonce: 'wrong' }), nonce: challenge.nonce })).error.code,
    'APP_PROOF_INVALID')
  for (let i = 1; i < 10; i += 1) assert.equal((await call({ provider: 'apple' })).status, 200)
  assert.equal((await call({ provider: 'apple' })).status, 429)
  time += 5 * 60 * 1000
  assert.equal((await call({ provider: 'apple', identityToken: proof('apple', { nonce: challenge.nonce }), nonce: challenge.nonce })).error.code,
    'APP_NONCE_INVALID')
  assert.equal((await call({ provider: 'apple' })).status, 200)
})

test('App identity restores saved profile and remaining membership after restart; default WeChat stays isolated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-app-restart-'))
  const path = join(dir, 'users.sqlite')
  const options = { channel: 'app', appIdentityVerifier: verifier() }
  let f = await createFixture(path, options)
  try {
    const first = await f.login('', { provider: 'google', identityToken: proof('google') }, 'app-login')
    const client = await f.connect({ token: first.token, playerId: first.playerId })
    const saved = await request(client.socket, 'user:updateProfile', { nickname: '恢复账号', avatar: '/assets/avatars/avatar-2.svg' })
    assert.equal(saved.ok, true)
    const vipExpiresAt = Date.now() + 86400000
    f.userStore.db.prepare('UPDATE users SET vip_expires_at = ? WHERE user_id = ?').run(vipExpiresAt, first.userId)
    await f.close()
    f = await createFixture(path, options)
    const restored = await f.login('', { provider: 'google', identityToken: proof('google') }, 'app-login')
    assert.equal(restored.userId, first.userId)
    assert.deepEqual(restored.profile, saved.profile)
    assert.equal(restored.membership.vipExpiresAt, vipExpiresAt)
    assert.equal(restored.membership.isVip, true)
    assert.equal((await f.connect({ token: first.token })).userId, first.userId)
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }) }
  const wechat = await createFixture()
  try {
    assert.equal((await fetch(`${wechat.url}/auth/app-login`, { method: 'POST' })).status, 404)
    assert.equal((await wechat.login('still-supported')).status, 200)
  } finally { await wechat.close() }
})

test('App entrypoint starts without any WeChat configuration and advertises unavailable platforms honestly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-app-entry-'))
  const UserStore = require('../src/user/UserStore')
  const { DELETED_APP_RETENTION_MS } = require('../src/user/app-retention')
  const seed = new UserStore(join(dir, 'users.sqlite'))
  const deleted = seed.findOrCreate({ provider: 'google', scope: 'entrypoint', subject: 'deleted-last-week' })
  const retained = seed.findOrCreate({ provider: 'google', scope: 'entrypoint', subject: 'active-account' })
  seed.deleteAppUser(deleted.userId, { now: Date.now() - DELETED_APP_RETENTION_MS - 1 })
  assert.ok(seed.isAppUserDeleted(deleted.userId))
  seed.close()
  const child = spawn(process.execPath, [join(__dirname, '../src/index.js')], {
    env: { ...process.env, USER_DB_PATH: join(dir, 'users.sqlite'), AUTH_TOKEN_SECRET: 'a'.repeat(32),
      APP_CHANNEL: 'app', WECHAT_APP_ID: '', WECHAT_APP_SECRET: '', APPLE_CLIENT_ID: '', GOOGLE_WEB_CLIENT_ID: '',
      VIP_PAYMENT_ENABLED: 'true', VIP_PRICE_FEN: 'invalid', HOST: '127.0.0.1', PORT: '0' },
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
    assert.deepEqual(health.auth, { channel: 'app', wechatLoginConfigured: false,
      appLoginConfigured: { apple: false, google: false }, appleDeletionConfigured: false })
    const inspected = new UserStore(join(dir, 'users.sqlite'))
    try {
      assert.equal(inspected.isAppUserDeleted(deleted.userId), false, 'startup purges expired deletion markers even with store sales off')
      assert.ok(inspected.getUser(retained.userId), 'retention never purges an active account')
    } finally { inspected.close() }
    for (const provider of ['apple', 'google']) {
      const response = await fetch(`${url}/auth/app-login`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }) })
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error.code, 'APP_LOGIN_NOT_CONFIGURED')
    }
    assert.equal((await fetch(`${url}/wechat/events`)).status, 404)
  } finally {
    child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  }
})

test('platform proofs expire by the seven-day deletion retention boundary including allowed future clock skew', async () => {
  const { DELETED_APP_RETENTION_MS, APP_PROOF_CLOCK_SKEW_MS, MAX_APP_IDENTITY_PROOF_LIFETIME_MS } = require('../src/user/app-retention')
  const deletedAt = Math.floor(Date.now() / 1000) * 1000
  let now = deletedAt
  const checker = verifier({ now: () => now })
  const iat = (deletedAt + APP_PROOF_CLOCK_SKEW_MS) / 1000
  const exp = iat + MAX_APP_IDENTITY_PROOF_LIFETIME_MS / 1000
  for (const provider of ['apple', 'google']) {
    const request = { provider, nonce: 'retention-proof', identityToken: proof(provider, { iat, exp, nonce: 'retention-proof' }) }
    await checker.verify(request)
    await assert.rejects(checker.verify({ ...request, identityToken: proof(provider, { iat, exp: exp + 1, nonce: 'retention-proof' }) }),
      { code: 'APP_PROOF_INVALID' })
    now = deletedAt + DELETED_APP_RETENTION_MS
    await assert.rejects(checker.verify(request), { code: 'APP_PROOF_INVALID' })
    now = deletedAt
  }
  assert.equal(require('../src/auth/tokens').TOKEN_TTL_MS, DELETED_APP_RETENTION_MS, 'App signing-token lifetime is unchanged')
})
