const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const UserStore = require('../src/user/UserStore')
const { createTokenService } = require('../src/auth/tokens')
const createAuthRouter = require('../src/auth/createAuthRouter')
const createAppLoginHandler = require('../src/auth/createAppLoginHandler')
const createAccountDeletionHandler = require('../src/auth/createAccountDeletionHandler')

const google = { provider: 'google', scope: 'test-google-client', subject: 'private-google-subject' }
const apple = { provider: 'apple', scope: 'test.apple.bundle', subject: 'private-apple-subject' }
const tokens = createTokenService('test-only-account-deletion-secret'.repeat(2))
function fixture(t, filename = ':memory:') {
  const store = new UserStore(filename)
  t.after(() => { if (store.db.open) store.close() })
  return store
}
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function invoke(handler, body = {}, token) {
  let status = 200, value
  await handler({ body, headers: token ? { authorization: `Bearer ${token}` } : {}, ip: '127.0.0.1' },
    { status(code) { status = code; return this }, json(body) { value = body; return this } })
  return { status, body: value }
}
function paidOrder(store, userId, now) {
  const order = store.appPayments.create(userId, 'delete-order-request-0001', { platform: 'ios', environment: 'sandbox',
    appId: apple.scope, storeProductId: 'vip_month.ios', productId: 'vip_month', durationDays: 30 }, now)
  const verified = { platform: order.platform, environment: order.environment, appId: order.app_id,
    storeProductId: order.store_product_id, accountToken: order.account_token, transactionId: `transaction-${order.out_trade_no}`,
    quantity: 1, status: 'purchased', purchasedAt: now, currency: 'USD', amountMicros: '2990000' }
  store.appPayments.grantVerified(order.out_trade_no, verified, now)
  return { order, verified }
}

test('App deletion removes real profile/identity rows, detaches finance and leaves WeChat accounts untouched', (t) => {
  const store = fixture(t)
  const now = Date.now()
  const app = store.findOrCreate(google)
  const wechat = store.findOrCreate({ provider: 'wechat_mini_program', scope: 'mini', subject: 'wx-subject' })
  store.updateProfile(app.userId, { nickname: '将删除的昵称', avatar: '/assets/avatars/avatar-2.svg' })
  const { order, verified } = paidOrder(store, app.userId, now)
  assert.ok(store.getUser(app.userId).vipExpiresAt > now)
  assert.deepEqual(store.deleteAppUser(app.userId, { expectedIdentity: google, now }), { deleted: true })
  assert.equal(store.getUser(app.userId), null)
  assert.equal(store.find.get(google.provider, google.scope, google.subject), undefined)
  assert.ok(store.getUser(wechat.userId))
  const retained = store.appPayments.require(order.out_trade_no)
  assert.equal(retained.user_id, null)
  assert.equal(retained.account_token, null)
  assert.equal(retained.deleted_at, now)
  assert.equal(retained.transaction_id, verified.transactionId)
  const retainedIdentity = JSON.stringify(store.db.prepare('SELECT * FROM app_deleted_identities').all())
  const retainedAccount = JSON.stringify(store.db.prepare('SELECT * FROM app_deleted_accounts').all())
  assert.equal(retainedIdentity.includes(google.subject), false)
  assert.equal(retainedIdentity.includes(google.scope), false)
  assert.equal(retainedAccount.includes(app.userId), false)
  assert.ok(store.isAppUserDeleted(app.userId))
  assert.deepEqual(store.deleteAppUser(app.userId), { deleted: true })
})

test('deletion rejects WeChat identities and refuses to detach an unexpected WeChat ledger', (t) => {
  const store = fixture(t)
  const wechat = store.findOrCreate({ provider: 'wechat_mini_program', scope: 'mini', subject: 'wx-subject' })
  assert.throws(() => store.deleteAppUser(wechat.userId), { code: 'APP_ACCOUNT_REQUIRED' })
  const app = store.findOrCreate(google)
  store.payments.create(app.userId, 'legacy-payment-request', 'legacy-open-id', {
    appId: 'wechat-app', offerId: 'offer', productId: 'vip_month', priceFen: 1000, durationDays: 30,
  }, Date.now())
  assert.throws(() => store.deleteAppUser(app.userId), { code: 'APP_ACCOUNT_REQUIRED' })
  assert.ok(store.getUser(app.userId))
  assert.ok(store.getUser(wechat.userId))
})

test('failed deletion rolls back finance detachment, tombstones and identity deletion as one transaction', (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(google)
  const { order } = paidOrder(store, app.userId, Date.now())
  store.db.exec("CREATE TRIGGER prevent_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'fault injection'); END")
  assert.throws(() => store.deleteAppUser(app.userId), { code: 'USER_STORE_UNAVAILABLE' })
  assert.ok(store.getUser(app.userId))
  assert.ok(store.find.get(google.provider, google.scope, google.subject))
  assert.equal(store.isAppUserDeleted(app.userId), false)
  assert.equal(store.appPayments.require(order.out_trade_no).user_id, app.userId)
  assert.equal(store.appPayments.require(order.out_trade_no).account_token, order.account_token)
  store.db.exec('DROP TRIGGER prevent_delete')
  store.deleteAppUser(app.userId)
  assert.equal(store.getUser(app.userId), null)
})

test('persistent fingerprints reject delayed proofs through clock skew and fresh authorization creates an empty new account', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iwodi-delete-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filename = join(dir, 'users.sqlite')
  const store = fixture(t, filename)
  const app = store.findOrCreate(google)
  const deletedAt = Date.now()
  const { order, verified } = paidOrder(store, app.userId, deletedAt)
  store.deleteAppUser(app.userId, { now: deletedAt })
  store.close()
  const reopened = fixture(t, filename)
  for (const issuedAt of [undefined, deletedAt - 1000, deletedAt, deletedAt + 59999, deletedAt + 60000]) {
    assert.throws(() => reopened.findOrCreate({ ...google, issuedAt }), { code: 'APP_REAUTH_REQUIRED' })
  }
  const fresh = reopened.findOrCreate({ ...google, issuedAt: deletedAt + 60001 })
  assert.notEqual(fresh.userId, app.userId)
  assert.equal(fresh.vipExpiresAt, 0)
  assert.throws(() => reopened.findOrCreate({ ...google, issuedAt: deletedAt - 1000 }), { code: 'APP_REAUTH_REQUIRED' },
    'an old proof also cannot log into the recreated account')
  assert.throws(() => reopened.appPayments.grantVerified(order.out_trade_no, verified, deletedAt + 70000), { code: 'APP_ACCOUNT_DELETED' })
})

test('Google DELETE requires the signed current account, commits before cleanup and is idempotent for its valid old token', async (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(google)
  const cleanup = []
  const handler = createAccountDeletionHandler({ userStore: store, tokens, deleteSession: (id) => {
    assert.equal(store.getUser(id), null)
    cleanup.push(id)
  } })
  const token = tokens.issue(app.userId).token
  assert.equal((await invoke(handler)).status, 401)
  assert.equal((await invoke(handler, {}, token + 'forged')).status, 401)
  assert.ok(store.getUser(app.userId))
  assert.deepEqual(await invoke(handler, {}, token), { status: 200, body: { deleted: true } })
  assert.deepEqual(await invoke(handler, {}, token), { status: 200, body: { deleted: true } })
  assert.deepEqual(cleanup, [app.userId, app.userId])
  assert.equal((await invoke(handler, {}, tokens.issue('never-created-account').token)).status, 401)
})

test('cleanup failure leaves a retryable deletion receipt and cannot report an active account as deleted', async (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(google), token = tokens.issue(app.userId).token
  let failing = true
  const handler = createAccountDeletionHandler({ userStore: store, tokens, deleteSession: () => {
    if (failing) throw new Error('injected cleanup fault')
  } })
  assert.equal((await invoke(handler, {}, token)).status, 503)
  assert.equal(store.getUser(app.userId), null)
  failing = false
  assert.deepEqual(await invoke(handler, {}, token), { status: 200, body: { deleted: true } })
})

test('Apple deletion consumes the shared challenge and waits for identity-bound revocation before committing', async (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(apple), token = tokens.issue(app.userId).token
  const challenges = new Map(), pending = deferred()
  let revoked = 0, cleaned = 0
  const login = createAppLoginHandler({ userStore: store, tokens, appChallenges: challenges,
    appIdentityVerifier: { requireProvider: () => undefined }, roomManager: {} })
  const challenge = await invoke(login, { provider: 'apple' })
  const handler = createAccountDeletionHandler({ userStore: store, tokens, appChallenges: challenges,
    appleRevocationClient: { revoke: async (input) => {
      revoked++
      assert.deepEqual(input.expectedIdentity, apple)
      assert.equal(input.nonce, challenge.body.nonce)
      await pending.promise
      return { revoked: true, identity: apple }
    } }, deleteSession: () => { cleaned++ } })
  const body = { authorizationCode: 'fresh-code', nonce: challenge.body.nonce }
  const first = invoke(handler, body, token), second = invoke(handler, body, token)
  assert.ok(store.getUser(app.userId), 'account remains intact while external revocation is pending')
  assert.equal(challenges.has(body.nonce), false)
  pending.resolve()
  assert.deepEqual(await first, { status: 200, body: { deleted: true } })
  assert.deepEqual(await second, { status: 200, body: { deleted: true } })
  assert.equal(revoked, 1)
  assert.equal(cleaned, 1)
  assert.deepEqual(await invoke(handler, body, token), { status: 200, body: { deleted: true } })
  assert.equal(revoked, 1, 'a retried deletion result never revokes again')
})

test('Apple revocation failure, wrong identity and expired nonce never delete the account', async (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(apple), token = tokens.issue(app.userId).token
  let response = async () => { throw Object.assign(new Error('Apple暂不可用'), { code: 'APPLE_REVOKE_UNAVAILABLE', statusCode: 503 }) }
  const challenges = new Map()
  const handler = createAccountDeletionHandler({ userStore: store, tokens, appChallenges: challenges,
    appleRevocationClient: { revoke: (...args) => response(...args) }, deleteSession: () => assert.fail('cleanup before revocation') })
  challenges.set('nonce-one', { expiresAt: Date.now() + 1000 })
  assert.equal((await invoke(handler, { authorizationCode: 'code', nonce: 'nonce-one' }, token)).status, 503)
  assert.ok(store.getUser(app.userId))
  assert.equal((await invoke(handler, { authorizationCode: 'code', nonce: 'nonce-one' }, token)).status, 401)
  challenges.set('nonce-two', { expiresAt: Date.now() + 1000 })
  response = async () => ({ revoked: true, identity: { ...apple, subject: 'other-identity' } })
  assert.equal((await invoke(handler, { authorizationCode: 'code', nonce: 'nonce-two' }, token)).status, 503)
  assert.ok(store.getUser(app.userId))
  challenges.set('expired', { expiresAt: Date.now() - 1 })
  assert.equal((await invoke(handler, { authorizationCode: 'code', nonce: 'expired' }, token)).status, 401)
  assert.equal(store.isAppUserDeleted(app.userId), false)
})

test('an App login already verifying an old proof cannot recreate an account after deletion', async (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(google), pending = deferred(), now = Date.now()
  const handler = createAppLoginHandler({ userStore: store, tokens, roomManager: { resolvePlayerIdByIdentity: () => assert.fail('old login restored') },
    appIdentityVerifier: { requireProvider: () => undefined, verify: () => pending.promise } })
  const login = invoke(handler, { provider: 'google', identityToken: 'awaiting-verified-proof' })
  store.deleteAppUser(app.userId, { now })
  pending.resolve({ ...google, issuedAt: now - 1000, expiresAt: now + 3600000 })
  const response = await login
  assert.equal(response.status, 401)
  assert.equal(response.body.error.code, 'APP_REAUTH_REQUIRED')
  assert.equal(store.find.get(google.provider, google.scope, google.subject), undefined)
})

test('account deletion route exists only on the App channel and shares its login challenge', () => {
  const app = createAuthRouter({ channel: 'app' })
  const wechat = createAuthRouter({ channel: 'wechat', appId: 'mini-app' })
  assert.ok(app.stack.some((layer) => layer.route.path === '/account' && layer.route.methods.delete))
  assert.equal(wechat.stack.some((layer) => layer.route.path === '/account'), false)
})

test('statusOnly resolves unknown deletion results without authorizing a new deletion or Apple revocation', async (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(apple), token = tokens.issue(app.userId).token
  let revoked = 0, cleaned = 0
  const handler = createAccountDeletionHandler({ userStore: store, tokens,
    appleRevocationClient: { revoke: () => { revoked++; assert.fail('status query revoked authorization') } },
    deleteSession: () => { cleaned++ } })
  assert.deepEqual(await invoke(handler, { statusOnly: true }, token), { status: 200, body: { deleted: false } })
  assert.ok(store.getUser(app.userId))
  assert.equal(revoked, 0)
  assert.equal(cleaned, 0)
  store.deleteAppUser(app.userId)
  assert.deepEqual(await invoke(handler, { statusOnly: true }, token), { status: 200, body: { deleted: true } })
  assert.equal(revoked, 0)
  assert.equal(cleaned, 1)
  assert.equal((await invoke(handler, { statusOnly: true }, tokens.issue('unknown').token)).status, 401)
})

test('statusOnly waits for an existing deletion to settle instead of reporting an account safe to reuse mid-revocation', async (t) => {
  const store = fixture(t)
  const app = store.findOrCreate(apple), token = tokens.issue(app.userId).token
  const pending = deferred(), challenges = new Map([['nonce', { expiresAt: Date.now() + 10000 }]])
  const handler = createAccountDeletionHandler({ userStore: store, tokens, appChallenges: challenges,
    appleRevocationClient: { revoke: async () => { await pending.promise; return { revoked: true, identity: apple } } },
    deleteSession: () => undefined })
  const deleting = invoke(handler, { nonce: 'nonce', authorizationCode: 'code' }, token)
  let result
  const querying = invoke(handler, { statusOnly: true }, token).then((value) => { result = value })
  await Promise.resolve()
  assert.equal(result, undefined)
  pending.resolve()
  await deleting
  await querying
  assert.deepEqual(result, { status: 200, body: { deleted: true } })
})
