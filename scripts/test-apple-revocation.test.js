const test = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign, verify } = require('node:crypto')
const { AppleRevocationClient } = require('../src/auth/AppleRevocationClient')
const { createAppIdentityVerifier } = require('../src/auth/createAppIdentityVerifier')

const now = Date.now()
const seconds = Math.floor(now / 1000)
const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const apple = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { teamId: 'TESTTEAM01', keyId: 'AUTHKEY001', clientId: 'com.test.app',
  privateKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const expectedIdentity = { provider: 'apple', scope: config.clientId, subject: 'current-user' }
const request = { authorizationCode: 'native-code-secret', nonce: 'server-issued-one-time-nonce', expectedIdentity }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

function proof(claims = {}, privateKey = apple.privateKey) {
  const body = [{ alg: 'RS256', kid: 'apple-key' }, { iss: 'https://appleid.apple.com', aud: config.clientId,
    sub: expectedIdentity.subject, iat: seconds, exp: seconds + 3600, nonce: request.nonce, ...claims }]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${body}.${sign('sha256', Buffer.from(body), privateKey).toString('base64url')}`
}

function fixture({ exchange, revoke, settings = config } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url === 'https://appleid.apple.com/auth/keys') {
      return json({ keys: [{ ...apple.publicKey.export({ format: 'jwk' }), kid: 'apple-key', alg: 'RS256', use: 'sig' }] })
    }
    if (url.endsWith('/token')) return exchange ? exchange(options) : json({ id_token: proof(), refresh_token: 'refresh-secret', access_token: 'access-secret' })
    if (url.endsWith('/revoke')) return revoke ? revoke(options) : new Response(null, { status: 200 })
    throw new Error('unexpected endpoint')
  }
  const appIdentityVerifier = createAppIdentityVerifier({ appleClientId: config.clientId, now: () => now, fetchKeys: fetchImpl })
  const client = new AppleRevocationClient({ config: settings, appIdentityVerifier, fetchImpl, now: () => now })
  return { client, calls }
}

test('Apple deletion exchanges a native code using an ES256 client secret, verifies the bound identity and revokes refresh token', async () => {
  const { client, calls } = fixture()
  const result = await client.revoke(request)
  assert.deepEqual(result, { revoked: true,
    identity: { ...expectedIdentity, issuedAt: seconds * 1000, expiresAt: (seconds + 3600) * 1000 } })
  assert.deepEqual(calls.map((call) => call.url), ['https://appleid.apple.com/auth/token',
    'https://appleid.apple.com/auth/keys', 'https://appleid.apple.com/auth/revoke'])
  const exchange = calls[0].options
  const form = new URLSearchParams(exchange.body)
  assert.equal(exchange.method, 'POST')
  assert.equal(exchange.redirect, 'error')
  assert.ok(exchange.signal instanceof AbortSignal)
  assert.equal(form.get('client_id'), config.clientId)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code'), request.authorizationCode)
  assert.equal(form.has('redirect_uri'), false)
  const [header, payload, signature] = form.get('client_secret').split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: config.keyId, typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')),
    { iss: config.teamId, sub: config.clientId, aud: 'https://appleid.apple.com', iat: seconds, exp: seconds + 300 })
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`),
    { key: signing.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true)
  const revoked = new URLSearchParams(calls[2].options.body)
  assert.equal(revoked.get('token'), 'refresh-secret')
  assert.equal(revoked.get('token_type_hint'), 'refresh_token')
  assert.equal(revoked.get('client_secret'), form.get('client_secret'))
  for (const secret of ['native-code-secret', 'refresh-secret', 'access-secret', form.get('client_secret')]) {
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(JSON.stringify(client).includes(secret), false)
  }
})

test('Apple falls back to the verified exchange access token when no refresh token is returned', async () => {
  const { client, calls } = fixture({ exchange: () => json({ id_token: proof(), access_token: 'access-secret' }) })
  assert.equal((await client.revoke(request)).revoked, true)
  const form = new URLSearchParams(calls.find((call) => call.url.endsWith('/revoke')).options.body)
  assert.equal(form.get('token'), 'access-secret')
  assert.equal(form.get('token_type_hint'), 'access_token')
})

test('Apple exchanged proofs for another account, audience, nonce or expired/forged signature never reach revocation', async () => {
  const otherSigner = generateKeyPairSync('rsa', { modulusLength: 2048 })
  for (const [idToken, code] of [
    [proof({ sub: 'other-user' }), 'APPLE_IDENTITY_MISMATCH'],
    [proof({ aud: 'other.app' }), 'APP_PROOF_INVALID'],
    [proof({ iss: 'https://attacker.example' }), 'APP_PROOF_INVALID'],
    [proof({ nonce: 'other-nonce' }), 'APP_PROOF_INVALID'],
    [proof({ exp: seconds - 1 }), 'APP_PROOF_INVALID'],
    [proof({}, otherSigner.privateKey), 'APP_PROOF_INVALID'],
  ]) {
    const { client, calls } = fixture({ exchange: () => json({ id_token: idToken, refresh_token: 'refresh-secret' }) })
    await assert.rejects(client.revoke(request), { code })
    assert.equal(calls.some((call) => call.url.endsWith('/revoke')), false)
  }
})

test('Apple exchange/revoke errors and ambiguous network results never return successful deletion evidence', async () => {
  for (const options of [
    { exchange: () => json({ error: 'invalid_grant', error_description: 'native-code-secret' }, 400), code: 'APPLE_REAUTH_REQUIRED' },
    { exchange: () => json({ error: 'invalid_client' }, 400) },
    { exchange: () => { throw new Error('native-code-secret') } },
    { exchange: () => new Response('access-secret', { status: 503 }) },
    { exchange: () => json(null) },
    { exchange: () => json({ id_token: proof() }) },
    { revoke: () => json({ error: 'invalid_client' }, 400) },
    { revoke: () => { throw new Error('refresh-secret') } },
    { revoke: () => json({ error: 'invalid_grant' }) },
    { revoke: () => new Response(null, { status: 204 }) },
  ]) {
    const { client, calls } = fixture(options)
    await assert.rejects(client.revoke(request), (error) => {
      assert.equal(error.code, options.code || 'APPLE_REVOKE_UNAVAILABLE')
      assert.equal(/native-code-secret|access-secret|refresh-secret/.test(error.message), false)
      return true
    })
    assert.equal(calls.filter((call) => call.url.endsWith('/token')).length, 1)
    assert.ok(calls.filter((call) => call.url.endsWith('/revoke')).length <= 1)
  }
})

test('Apple missing configuration, wrong key type or invalid identity input fail before contacting the platform', async () => {
  for (const settings of [{}, { ...config, privateKey: 'invalid-private-key' },
    { ...config, privateKey: apple.privateKey.export({ type: 'pkcs8', format: 'pem' }) }]) {
    const { client, calls } = fixture({ settings })
    await assert.rejects(client.revoke(request), { code: 'APPLE_REVOKE_NOT_CONFIGURED' })
    assert.equal(calls.length, 0)
  }
  for (const body of [{ ...request, authorizationCode: '' }, { ...request, nonce: '' },
    { ...request, expectedIdentity: { ...expectedIdentity, provider: 'google' } },
    { ...request, expectedIdentity: { ...expectedIdentity, scope: 'other.app' } }]) {
    const { client, calls } = fixture()
    await assert.rejects(client.revoke(body), (error) => ['APPLE_REAUTH_REQUIRED', 'APPLE_IDENTITY_MISMATCH'].includes(error.code))
    assert.equal(calls.length, 0)
  }
})
