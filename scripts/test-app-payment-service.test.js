const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const UserStore = require('../src/user/UserStore')
const { AppPaymentService } = require('../src/payment/AppPaymentService')
const { readAppPaymentConfig } = require('../src/payment/app-config')
const { DAY_MS } = require('../src/payment/config')

function config() {
  return { enabled: true, configured: true, productId: 'vip_month', durationDays: 30,
    platforms: {
      ios: { enabled: true, configured: true, appId: 'test.ios', storeProductId: 'vip.ios', environment: 'sandbox' },
      android: { enabled: true, configured: true, appId: 'test.android', storeProductId: 'vip.android', environment: 'sandbox' },
    } }
}
function fixture(t, filename = ':memory:') {
  const store = new UserStore(filename)
  const user = store.findOrCreate({ provider: 'apple', scope: 'app', subject: 'one' })
  let time = Date.now()
  const responses = new Map(), log = [], completed = []
  const platform = {
    verify: async (input) => {
      const result = responses.get(input.transactionId || input.purchaseToken)
      if (!result) throw Object.assign(new Error('upstream unavailable'), { code: 'APP_STORE_UNAVAILABLE' })
      return { ...result }
    },
    complete: async (info) => { completed.push(info.transactionId); return { finished: true } },
    verifyNotification: async (_platform, { body }) => ({ locator: body }),
  }
  const service = new AppPaymentService({ userStore: store, config: config(), client: platform,
    now: () => time, logger: { warn: (...args) => log.push(args) } })
  t.after(async () => { await service.stop(); if (store.db.open) store.close() })
  const create = async (requestId = 'payment-request-0001', channel = 'android') => {
    const response = await service.create(user.userId, { requestId, platform: channel, productId: 'vip_month' })
    return store.appPayments.require(response.order.outTradeNo)
  }
  const paid = (order, overrides = {}) => ({ platform: order.platform, environment: order.environment, appId: order.app_id,
    storeProductId: order.store_product_id, accountToken: order.account_token, transactionId: `transaction-${order.out_trade_no}`,
    purchaseToken: order.platform === 'android' ? `purchase-${order.out_trade_no}` : undefined,
    status: 'purchased', quantity: 1, purchasedAt: time, currency: 'EUR', amountMicros: '2990000', ...overrides })
  const register = (info) => { if (info.transactionId) responses.set(info.transactionId, info); if (info.purchaseToken) responses.set(info.purchaseToken, info); return info }
  const confirm = (order, info = register(paid(order)), uid = user.userId) => service.confirmPurchase(uid,
    { platform: order.platform, outTradeNo: order.out_trade_no, transactionId: info.transactionId, purchaseToken: info.purchaseToken })
  return { store, user, service, platform, responses, completed, log, create, paid, register, confirm,
    get now() { return time }, tick(ms) { time += ms } }
}

test('App config is separately gated, has fixed duration and no currency fallback', () => {
  const empty = readAppPaymentConfig({})
  assert.equal(empty.enabled, false)
  assert.equal(empty.configured, false)
  assert.equal(empty.productId, 'vip_month')
  assert.equal(empty.durationDays, 30)
  assert.equal('priceFen' in empty, false)
  assert.throws(() => readAppPaymentConfig({ APP_VIP_PAYMENT_ENABLED: 'true' }), /配置/)
  assert.throws(() => readAppPaymentConfig({ APPLE_STORE_ENVIRONMENT: 'unknown' }), /sandbox/)
  assert.throws(() => readAppPaymentConfig({ GOOGLE_STORE_PRODUCT_ID: '../invalid/' }), /商品/)
  const androidOnly = readAppPaymentConfig({ APP_VIP_PAYMENT_ENABLED: 'true', APPLE_STORE_ENABLED: 'false',
    GOOGLE_STORE_PACKAGE_NAME: 'test.package', GOOGLE_STORE_PRODUCT_ID: 'vip_month', GOOGLE_STORE_CLIENT_EMAIL: 'service@test',
    GOOGLE_STORE_PRIVATE_KEY: 'line1\\nline2', GOOGLE_STORE_NOTIFICATION_AUDIENCE: 'https://test/events', GOOGLE_STORE_NOTIFICATION_EMAIL: 'push@test' })
  assert.equal(androidOnly.platforms.android.configured, true)
  assert.equal(androidOnly.platforms.android.serviceAccount.private_key, 'line1\nline2')
})

test('one request creates one invocation and unknown pending blocks another purchase', async (t) => {
  const f = fixture(t)
  const payload = { platform: 'android', productId: 'vip_month', requestId: 'payment-request-0001' }
  const replies = await Promise.all([f.service.create(f.user.userId, payload), f.service.create(f.user.userId, payload)])
  assert.equal(replies[0].order.outTradeNo, replies[1].order.outTradeNo)
  assert.ok(replies[0].payment.accountToken.match(/^[a-f0-9-]{36}$/))
  assert.equal(replies[1].payment, undefined)
  await assert.rejects(f.create('payment-request-0002'), { code: 'VIP_ORDER_PENDING' })
  const queried = await f.service.queryOwn(f.user.userId)
  assert.equal(queried.order.status, 'pending')
  assert.equal(queried.payment, undefined)
  assert.equal('priceFen' in queried.order, false)
  assert.equal(JSON.stringify(queried).includes('accountToken'), false)
  f.service.config.enabled = false
  assert.equal((await f.service.create(f.user.userId, payload)).order.outTradeNo, replies[0].order.outTradeNo)
  await assert.rejects(f.create('payment-request-0002'), { code: 'VIP_NOT_FOR_SALE' })
})

test('concurrent confirmations grant once and platform completion sees durable entitlement first', async (t) => {
  const f = fixture(t)
  const order = await f.create(), info = f.register(f.paid(order))
  let changes = 0
  f.service.on('changed', () => changes++)
  f.platform.complete = async () => {
    assert.equal(f.store.appPayments.require(order.out_trade_no).status, 'granted')
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, f.now + 30 * DAY_MS)
    return { finished: true }
  }
  const results = await Promise.all(Array.from({ length: 5 }, () => f.confirm(order, info)))
  assert.equal(changes, 1)
  assert.equal(new Set(results.map((r) => r.order.endsAt)).size, 1)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, f.now + 30 * DAY_MS)
  assert.ok(results[0].order.finishedAt)
})

test('platform identity, environment, product, quantity and cross-account claims fail closed', async (t) => {
  const f = fixture(t)
  const order = await f.create()
  for (const override of [{ accountToken: 'another-order' }, { environment: 'production' }, { appId: 'other.app' },
    { storeProductId: 'other.sku' }, { quantity: 2 }, { platform: 'ios' }]) {
    const info = f.register(f.paid(order, override))
    await assert.rejects(f.confirm(order, info), { code: 'PAYMENT_ORDER_MISMATCH' })
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  }
  const other = f.store.findOrCreate({ provider: 'google', scope: 'app', subject: 'two' })
  const info = f.register(f.paid(order))
  await assert.rejects(f.confirm(order, info, other.userId), { code: 'VIP_ORDER_NOT_FOUND' })
  await assert.rejects(f.service.queryOwn(other.userId, { outTradeNo: order.out_trade_no }), { code: 'VIP_ORDER_NOT_FOUND' })
})

test('native cancellation releases only an unlocated attempt and a later verified payment still grants its own order', async (t) => {
  const f = fixture(t)
  const old = await f.create()
  const cancelled = await f.service.queryOwn(f.user.userId, { outTradeNo: old.out_trade_no, nativeCancelled: true })
  assert.equal(cancelled.order.status, 'closed')
  const newer = await f.create('payment-request-0002')
  const late = f.register(f.paid(old))
  const result = await f.service.confirmPurchase(f.user.userId, { platform: 'android', purchaseToken: late.purchaseToken })
  assert.equal(result.order.outTradeNo, old.out_trade_no)
  assert.equal(result.order.status, 'granted')
  assert.equal(f.store.appPayments.require(newer.out_trade_no).status, 'pending')
  const pending = f.register(f.paid(newer, { status: 'pending', transactionId: null, purchasedAt: null }))
  await f.confirm(newer, pending)
  assert.equal((await f.service.queryOwn(f.user.userId, { outTradeNo: newer.out_trade_no, nativeCancelled: true })).order.status, 'pending')
})

test('platform cancellation blocks late success, pending replays and completion even when later queries fail', async (t) => {
  for (const marker of [null, 'nativeCancelled', 'purchaseNotStarted']) {
    await t.test(marker || 'pending', async (t) => {
      const f = fixture(t), order = await f.create(), paid = f.register(f.paid(order))
      if (marker) await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no, [marker]: true })
      const verify = f.platform.verify
      let resolveLate
      f.platform.verify = () => new Promise((resolve) => { resolveLate = resolve })
      const confirming = f.confirm(order, paid)
      f.platform.verify = verify
      f.register({ ...paid, status: 'cancelled', purchasedAt: null })
      const locator = { platform: order.platform, purchaseToken: paid.purchaseToken }
      await f.service.notification(order.platform, locator, {})
      resolveLate(paid)
      assert.equal((await confirming).order.status, 'closed')
      const pending = f.register({ ...paid, status: 'pending', transactionId: null, purchasedAt: null })
      assert.equal((await f.confirm(order, pending)).order.status, 'closed')
      f.register(paid)
      await f.service.notification(order.platform, locator, {})
      await f.service.notification(order.platform, locator, {})
      f.platform.verify = async () => { throw Object.assign(new Error('unavailable'), { code: 'APP_STORE_UNAVAILABLE' }) }
      f.tick(3000)
      assert.equal((await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })).order.status, 'closed')
      const final = f.store.appPayments.require(order.out_trade_no)
      assert.equal(final.platform_status, 'cancelled')
      assert.equal(final.closure_reason, 'platform_cancelled')
      assert.equal(final.granted_at, null)
      assert.equal(final.platform_ack_at, null)
      assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
      assert.equal(f.completed.length, 0)
    })
  }
})

test('finish failure preserves one durable grant and restart retries completion without extending VIP', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iwodi-app-service-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filename = join(dir, 'users.sqlite')
  const f = fixture(t, filename)
  const order = await f.create(), info = f.register(f.paid(order))
  f.platform.complete = async () => { throw Object.assign(new Error('do not log purchase-token'), { code: 'APP_STORE_UNAVAILABLE' }) }
  const granted = await f.confirm(order, info)
  assert.equal(granted.order.status, 'granted')
  assert.equal(granted.order.finishedAt, null)
  assert.equal(JSON.stringify(f.log).includes('purchase-token'), false)
  await assert.rejects(f.create('payment-request-0002'), { code: 'VIP_ORDER_PENDING' })
  const expiry = f.store.getUser(f.user.userId).vipExpiresAt
  await f.service.stop()
  f.store.close()
  const restored = fixture(t, filename)
  restored.register(info)
  restored.tick(6 * 60 * 1000)
  await restored.service.sweep()
  assert.ok(restored.store.appPayments.require(order.out_trade_no).platform_ack_at)
  assert.equal(restored.store.getUser(restored.user.userId).vipExpiresAt, expiry)
})

test('verified refunds, out-of-order payment notifications and restore never duplicate or revive entitlement', async (t) => {
  const f = fixture(t)
  const order = await f.create(), purchased = f.register(f.paid(order))
  const refunded = f.register({ ...purchased, status: 'refunded', refundId: 'refund-1', refundedAt: f.now })
  await f.service.notification('android', { platform: 'android', purchaseToken: refunded.purchaseToken }, {})
  f.register(purchased)
  assert.equal((await f.confirm(order, purchased)).order.status, 'refunded')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  const restored = await f.service.queryOwn(f.user.userId, { restore: true })
  assert.equal(restored.orders.length, 1)
  assert.equal(restored.orders[0].status, 'refunded')
  assert.equal(f.completed.length, 0)
})

test('revoking an earlier order preserves consumed time and advances the next paid interval', async (t) => {
  const f = fixture(t)
  const first = await f.create(), firstInfo = f.register(f.paid(first))
  await f.confirm(first, firstInfo)
  const second = await f.create('payment-request-0002')
  await f.confirm(second)
  f.tick(10 * DAY_MS)
  f.register({ ...firstInfo, status: 'refunded', refundId: 'refund-2', refundedAt: f.now })
  await f.service.reconcile(first.out_trade_no, { force: true })
  const next = f.store.appPayments.require(second.out_trade_no)
  assert.equal(next.starts_at, f.now)
  assert.equal(next.ends_at, f.now + 30 * DAY_MS)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, next.ends_at)
})

test('notification authentication errors do not query or modify the ledger', async (t) => {
  const f = fixture(t)
  const order = await f.create()
  f.platform.verifyNotification = async () => { throw Object.assign(new Error('secret'), { code: 'PAYMENT_NOTIFICATION_INVALID' }) }
  await assert.rejects(f.service.notification('android', { purchaseToken: 'forged' }, {}), { code: 'PAYMENT_NOTIFICATION_INVALID' })
  assert.equal(f.store.appPayments.require(order.out_trade_no).status, 'pending')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
})

test('stop is idempotent, never purchases, and rejects an in-flight stale account before granting', async (t) => {
  const f = fixture(t)
  const order = await f.create(), info = f.paid(order)
  let resolve
  f.platform.verify = () => new Promise((done) => { resolve = done })
  let active = true
  const confirming = f.service.confirmPurchase(f.user.userId, { platform: 'android', purchaseToken: info.purchaseToken }, () => active)
  active = false
  resolve(info)
  await assert.rejects(confirming, { code: 'SESSION_REPLACED' })
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  await f.service.stop()
  await f.service.stop()
  await f.service.sweep()
  await assert.rejects(f.create('payment-request-0002'), { code: 'PAYMENT_STOPPED' })
})

test('Apple grants before device finish, survives lost completion receipt, then permits a new purchase', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iwodi-apple-finish-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filename = join(dir, 'users.sqlite')
  const f = fixture(t, filename)
  const order = await f.create('payment-request-0001', 'ios'), info = f.register(f.paid(order))
  f.platform.complete = async () => ({ finished: false })
  const granted = await f.confirm(order, info)
  assert.equal(granted.order.status, 'granted')
  assert.equal(granted.order.finishedAt, null)
  await assert.rejects(f.create('payment-request-0002', 'ios'), { code: 'VIP_ORDER_PENDING' })
  const expiry = f.store.getUser(f.user.userId).vipExpiresAt
  await f.service.stop()
  f.store.close()
  const restored = fixture(t, filename)
  restored.register(info)
  restored.platform.complete = async () => ({ finished: false })
  assert.equal((await restored.service.queryOwn(restored.user.userId, { restore: true })).order.finishedAt, null)
  const receipt = await restored.service.queryOwn(restored.user.userId, { outTradeNo: order.out_trade_no, nativeFinished: true })
  assert.ok(receipt.order.finishedAt)
  const duplicate = await restored.service.queryOwn(restored.user.userId, { outTradeNo: order.out_trade_no, nativeFinished: true })
  assert.equal(duplicate.order.finishedAt, receipt.order.finishedAt)
  assert.equal(restored.store.getUser(restored.user.userId).vipExpiresAt, expiry)
  const next = await restored.create('payment-request-0002', 'ios')
  await assert.rejects(restored.service.queryOwn(restored.user.userId, { outTradeNo: next.out_trade_no, nativeFinished: true }),
    { code: 'PAYMENT_NOT_CONFIRMED' })
})

test('a platform notification arriving before client confirmation grants once and rejects foreign order binding', async (t) => {
  const f = fixture(t)
  const order = await f.create(), info = f.register(f.paid(order))
  let changes = 0
  f.service.on('changed', () => changes++)
  const locator = { platform: 'android', purchaseToken: info.purchaseToken }
  await f.service.notification('android', locator, {})
  await f.service.notification('android', locator, {})
  await f.confirm(order, info)
  assert.equal(changes, 1)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, f.now + 30 * DAY_MS)
  const other = await f.create('payment-request-0002')
  await assert.rejects(f.service.confirmPurchase(f.user.userId,
    { ...locator, outTradeNo: other.out_trade_no }), { code: 'PAYMENT_ORDER_MISMATCH' })
  assert.equal(f.store.appPayments.require(other.out_trade_no).status, 'pending')
})

test('notification router returns retry status without exposing sensitive body or errors', async () => {
  const createRouter = require('../src/payment/createAppEventsRouter')
  const calls = []
  let failure
  const service = { notification: async (...args) => { calls.push(args); if (failure) throw failure }, warn: () => undefined }
  const router = createRouter(service)
  const apple = router.stack.find((layer) => layer.route.path === '/apple').route.stack[0].handle
  const req = { body: { signedPayload: 'do-not-expose' }, headers: { authorization: 'secret' } }
  const statuses = []
  const res = { sendStatus: (status) => statuses.push(status) }
  await apple(req, res)
  assert.equal(calls[0][0], 'ios')
  failure = Object.assign(new Error('raw token'), { code: 'PAYMENT_NOTIFICATION_INVALID' })
  await apple(req, res)
  failure = Object.assign(new Error('raw token'), { code: 'APP_STORE_UNAVAILABLE' })
  await apple(req, res)
  assert.deepEqual(statuses, [204, 403, 503])
})

test('refund detected between durable grant and consume is applied immediately without finishing the transaction', async (t) => {
  const f = fixture(t)
  const order = await f.create(), purchased = f.register(f.paid(order))
  f.platform.complete = async () => ({ finished: false,
    verified: { ...purchased, status: 'refunded', refundId: 'race-refund', refundedAt: f.now } })
  const response = await f.confirm(order, purchased)
  assert.equal(response.order.status, 'refunded')
  assert.equal(response.order.finishedAt, null)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, f.now)
})

test('a lost create response can close an intent that native purchase never invoked, without auto-purchasing', async (t) => {
  const f = fixture(t)
  const payload = { platform: 'ios', productId: 'vip_month', requestId: 'payment-request-0001' }
  const creating = f.service.create(f.user.userId, payload)
  const recovery = f.service.queryOwn(f.user.userId, { requestId: payload.requestId, purchaseNotStarted: true })
  const [created, recovered] = await Promise.all([creating, recovery])
  assert.equal(recovered.order.outTradeNo, created.order.outTradeNo)
  assert.equal(recovered.order.status, 'closed')
  assert.equal(recovered.payment, undefined)
  assert.equal(f.store.appPayments.require(created.order.outTradeNo).closure_reason, 'purchase_not_started')
  const old = f.store.appPayments.require(created.order.outTradeNo)
  await f.create('payment-request-0002', 'ios')
  f.platform.complete = async () => ({ finished: false })
  assert.equal((await f.confirm(old)).order.status, 'granted', 'a later verified payment still belongs to the original intent')
})

test('a delayed pending verification cannot roll back a granted order or finish the pending snapshot', async (t) => {
  const f = fixture(t)
  const order = await f.create(), info = f.register(f.paid(order))
  f.platform.complete = async () => { throw Object.assign(new Error('ambiguous consume'), { code: 'APP_STORE_UNAVAILABLE' }) }
  await f.confirm(order, info)
  let completes = 0
  f.platform.complete = async () => { completes++; return { finished: true } }
  const pending = f.register({ ...info, status: 'pending', transactionId: null, purchasedAt: null })
  const response = await f.confirm(order, pending)
  assert.equal(response.order.status, 'granted')
  assert.equal(response.order.finishedAt, null)
  assert.equal(completes, 0)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, f.now + 30 * DAY_MS)
})

test('deleted pending orders record late verified payments and refunds without granting, consuming or restoring an account', async (t) => {
  const f = fixture(t)
  const order = await f.create(), paid = f.register(f.paid(order))
  f.store.deleteAppUser(f.user.userId, { now: f.now })
  let changes = 0
  f.service.on('changed', () => changes++)
  const locator = { platform: order.platform, purchaseToken: paid.purchaseToken }
  const router = require('../src/payment/createAppEventsRouter')(f.service)
  const notification = router.stack.find((layer) => layer.route.path === '/google').route.stack[0].handle
  let status
  await notification({ body: locator, headers: {} }, { sendStatus: (value) => { status = value } })
  assert.equal(status, 204)
  await f.service.notification(order.platform, locator, {})
  const recorded = f.store.appPayments.require(order.out_trade_no)
  assert.equal(recorded.user_id, null)
  assert.equal(recorded.account_token, null)
  assert.match(recorded.account_token_hash, /^[a-f0-9]{64}$/)
  assert.equal(recorded.transaction_id, paid.transactionId)
  assert.equal(recorded.purchase_token, paid.purchaseToken)
  assert.equal(recorded.currency, 'EUR')
  assert.equal(recorded.amount_micros, '2990000')
  assert.equal(recorded.platform_status, 'purchased')
  assert.equal(recorded.granted_at, null)
  assert.equal(recorded.platform_ack_at, null)
  assert.equal(f.store.getUser(f.user.userId), null)
  assert.equal(f.completed.length, 0)
  assert.equal(changes, 0)
  await assert.rejects(f.confirm(order, paid), { code: 'VIP_ORDER_NOT_FOUND' })
  const fresh = f.store.findOrCreate({ provider: 'google', scope: 'app', subject: 'fresh-account' })
  const newOrder = await f.service.create(fresh.userId, { platform: 'android', productId: 'vip_month', requestId: 'payment-request-0002' })
  const replacement = f.store.appPayments.require(newOrder.order.outTradeNo)
  f.register({ ...paid, accountToken: replacement.account_token })
  await assert.rejects(f.service.confirmPurchase(fresh.userId, { ...locator, outTradeNo: replacement.out_trade_no }),
    { code: 'PAYMENT_TRANSACTION_CLAIMED' })
  f.register({ ...paid, status: 'refunded', refundId: 'deleted-late-refund', refundedAt: f.now })
  await f.service.notification(order.platform, locator, {})
  await f.service.notification(order.platform, locator, {})
  assert.equal(f.store.appPayments.require(order.out_trade_no).status, 'refunded')
  assert.equal(f.store.getUser(fresh.userId).vipExpiresAt, 0)
  assert.equal(f.completed.length, 0)
  assert.equal(changes, 0)
})

test('deleted granted orders acknowledge purchased replays and background reconciliation without redelivery or consume', async (t) => {
  const f = fixture(t)
  const order = await f.create(), paid = f.register(f.paid(order))
  f.platform.complete = async () => { throw Object.assign(new Error('unfinished before deletion'), { code: 'APP_STORE_UNAVAILABLE' }) }
  await f.confirm(order, paid)
  f.store.deleteAppUser(f.user.userId, { now: f.now })
  let consumes = 0, changes = 0
  f.platform.complete = async () => { consumes++; return { finished: true } }
  f.service.on('changed', () => changes++)
  await f.service.notification(order.platform, { platform: order.platform, purchaseToken: paid.purchaseToken }, {})
  await f.service.reconcile(order.out_trade_no, { force: true })
  assert.equal(f.store.appPayments.require(order.out_trade_no).platform_ack_at, null)
  assert.equal(f.store.getUser(f.user.userId), null)
  assert.equal(consumes, 0)
  assert.equal(changes, 0)
})

test('deletion during a platform query switches the late result to financial recording without delivery', async (t) => {
  const f = fixture(t)
  const order = await f.create(), paid = f.paid(order)
  f.store.appPayments.recordVerified(order.out_trade_no, { ...paid, status: 'pending', transactionId: null, purchasedAt: null })
  let resolve
  f.platform.verify = () => new Promise((done) => { resolve = done })
  const reconciling = f.service.reconcile(order.out_trade_no, { force: true })
  await Promise.resolve()
  await Promise.resolve()
  f.store.deleteAppUser(f.user.userId, { now: f.now })
  resolve(paid)
  const response = await reconciling
  assert.equal(response.user_id, null)
  assert.equal(response.transaction_id, paid.transactionId)
  assert.equal(response.granted_at, null)
  assert.equal(f.completed.length, 0)
})

test('purged historical transactions are acknowledged only after verification and cannot be claimed by a new account', async (t) => {
  const { DELETED_APP_RETENTION_MS } = require('../src/user/app-retention')
  const f = fixture(t), order = await f.create(), paid = f.register(f.paid(order))
  f.store.deleteAppUser(f.user.userId, { now: f.now })
  f.tick(DELETED_APP_RETENTION_MS)
  f.store.purgeDeletedAppData(f.now)
  const locator = { platform: order.platform, purchaseToken: paid.purchaseToken }
  let verifies = 0
  const verify = f.platform.verify
  f.platform.verify = async (input) => { verifies++; return verify(input) }
  await f.service.notification(order.platform, locator, {})
  assert.equal(verifies, 1)
  assert.equal(f.store.appPayments.byId.get(order.out_trade_no), undefined)
  assert.equal(f.completed.length, 0)
  const fresh = f.store.findOrCreate({ provider: 'google', scope: 'app', subject: 'new-after-retention' })
  const next = await f.service.create(fresh.userId, { platform: 'android', productId: 'vip_month', requestId: 'new-retention-order' })
  await assert.rejects(f.service.confirmPurchase(fresh.userId, locator), { code: 'VIP_ORDER_NOT_FOUND' })
  await assert.rejects(f.service.confirmPurchase(fresh.userId, { ...locator, outTradeNo: next.order.outTradeNo }),
    { code: 'PAYMENT_ORDER_MISMATCH' })
  assert.equal(f.store.getUser(fresh.userId).vipExpiresAt, 0)
  assert.equal(f.store.appPayments.require(next.order.outTradeNo).status, 'pending')
  f.platform.verifyNotification = async () => { throw Object.assign(new Error('unverified'), { code: 'PAYMENT_NOTIFICATION_INVALID' }) }
  await assert.rejects(f.service.notification(order.platform, locator, {}), { code: 'PAYMENT_NOTIFICATION_INVALID' })
  assert.equal(verifies, 3, 'a failed notification signature must not reach transaction verification')
})
