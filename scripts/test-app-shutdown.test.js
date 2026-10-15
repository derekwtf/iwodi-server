const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')
const { connect: connectTcp } = require('node:net')
const { io: connect } = require('socket.io-client')
const UserStore = require('../src/user/UserStore')
const { createTokenService } = require('../src/auth/tokens')
const { request } = require('./auth-fixture')

const secret = 'app-shutdown-test-only-'.repeat(3)
const identity = { provider: 'apple', scope: 'test.shutdown', subject: 'owner', issuedAt: Date.now() }
// Only the subprocess test injects a delayed platform response. The real entrypoint,
// HTTP router, account transaction, Socket server and database remain unchanged.
const delayedRevocation = `
const { AppleRevocationClient } = require('./src/auth/AppleRevocationClient')
AppleRevocationClient.prototype.revoke = async ({ expectedIdentity }) => {
  console.log('TEST_REVOCATION_STARTED')
  await new Promise(resolve => setTimeout(resolve, 180))
  return { revoked: true, identity: expectedIdentity }
}
require('./src/index.js')
`

async function start(t, bootstrap = "require('./src/index.js')") {
  const directory = mkdtempSync(join(tmpdir(), 'iwodi-app-shutdown-'))
  const filename = join(directory, 'users.sqlite')
  const store = new UserStore(filename)
  const user = store.findOrCreate(identity)
  store.close()
  const child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, APP_CHANNEL: 'app', USER_DB_PATH: filename, AUTH_TOKEN_SECRET: secret,
      APPLE_CLIENT_ID: identity.scope, HOST: '127.0.0.1', PORT: '0', APP_VIP_PAYMENT_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', exited = false
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const stopped = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) })
  })
  t.after(async () => {
    if (!exited) child.kill('SIGKILL')
    await stopped
    rmSync(directory, { recursive: true, force: true })
  })
  const waitFor = async (pattern) => {
    const deadline = Date.now() + 4000
    while (!pattern.test(output)) {
      assert.equal(exited, false, output)
      assert.ok(Date.now() < deadline, `subprocess timed out: ${output}`)
      await delay(10)
    }
    return output.match(pattern)
  }
  const url = (await waitFor(/listening on (http:\/\/[^\s]+)/))[1]
  return { child, stopped, waitFor, url, filename, user, output: () => output,
    token: createTokenService(secret).issue(user.userId).token }
}

test('App SIGTERM closes active sockets and rooms, keeps durable profiles and exits cleanly', { timeout: 6000 }, async (t) => {
  const f = await start(t)
  const socket = connect(f.url, { auth: { token: f.token }, reconnection: false, transports: ['websocket'] })
  t.after(() => socket.close())
  await new Promise((resolve, reject) => { socket.once('connect:success', resolve); socket.once('connect_error', reject) })
  assert.equal((await request(socket, 'room:create')).ok, true)
  assert.equal((await request(socket, 'user:updateProfile', { nickname: '停服后保留', avatar: f.user.avatar })).ok, true)
  const disconnected = new Promise((resolve) => socket.once('disconnect', resolve))
  f.child.kill('SIGTERM')
  await disconnected
  assert.deepEqual(await f.stopped, { code: 0, signal: null }, f.output())
  const restored = new UserStore(f.filename)
  try { assert.equal(restored.getUser(f.user.userId).nickname, '停服后保留') }
  finally { restored.close() }
})

for (const abortResponse of [false, true]) {
  test(`App shutdown drains an accepted account deletion${abortResponse ? ' after the client disconnects' : ''}`, { timeout: 6000 }, async (t) => {
    const f = await start(t, delayedRevocation)
    const nonce = (await (await fetch(`${f.url}/auth/app-login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'apple' }) })).json()).nonce
    assert.ok(nonce)
    const controller = new AbortController()
    const response = fetch(`${f.url}/auth/account`, { method: 'DELETE', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ nonce, authorizationCode: 'test-only' }) })
      .then(async (result) => ({ status: result.status, body: await result.json() }), (error) => ({ error }))
    await f.waitFor(/TEST_REVOCATION_STARTED/)
    if (abortResponse) controller.abort()
    f.child.kill('SIGTERM')
    await delay(25)
    f.child.kill('SIGTERM') // A repeated signal must not interrupt the first drain.
    const result = await response
    if (!abortResponse) assert.deepEqual(result, { status: 200, body: { deleted: true } })
    assert.deepEqual(await f.stopped, { code: 0, signal: null }, f.output())
    const restored = new UserStore(f.filename)
    try {
      assert.equal(restored.getUser(f.user.userId), null)
      assert.equal(restored.isAppUserDeleted(f.user.userId), true)
    } finally { restored.close() }
  })
}

test('App shutdown has a finite deadline when an HTTP request never completes', { timeout: 30_000 }, async (t) => {
  const f = await start(t)
  const endpoint = new URL(f.url)
  const socket = connectTcp({ host: endpoint.hostname, port: Number(endpoint.port) })
  socket.on('error', () => {})
  t.after(() => socket.destroy())
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write('POST /auth/app-login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{')
  await delay(30)
  f.child.kill('SIGTERM')
  assert.deepEqual(await f.stopped, { code: 1, signal: null }, f.output())
  assert.match(f.output(), /\[app-shutdown\] DRAIN_TIMEOUT/)
  const restored = new UserStore(f.filename)
  try { assert.ok(restored.getUser(f.user.userId)) }
  finally { restored.close() }
})
