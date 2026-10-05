const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const UserStore = require('../src/user/UserStore')
const { readPaymentConfig, DAY_MS } = require('../src/payment/config')
const { PaymentService, publicOrder } = require('../src/payment/PaymentService')
const { WechatPaymentClient, paySignature, hmac } = require('../src/payment/WechatPaymentClient')
const { MessageCipher, signature } = require('../src/payment/MessageCipher')
const { createFixture, request, fillRoom } = require('./auth-fixture')

const config = readPaymentConfig({ VIP_PAYMENT_ENABLED: 'true', WECHAT_APP_ID: 'test-app',
  WECHAT_APP_SECRET: 'test-secret', VIP_OFFER_ID: '123', VIP_APP_KEY: 'test-appkey',
  WECHAT_MESSAGE_TOKEN: 'test-token', WECHAT_MESSAGE_AES_KEY: 'A'.repeat(43) })
const start = Date.UTC(2026, 0, 1)
const paid = (order, extra = {}) => ({ order: { order_id: order.out_trade_no, wx_order_id: `wx-${order.out_trade_no}`,
  env_type: 1, order_type: 0, status: 2, order_fee: 1000, paid_fee: 1000, left_fee: 1000, paid_time: start / 1000, ...extra } })
function fixture(t, { filename = ':memory:', platform = {} } = {}) {
  const store = new UserStore(filename)
  t.after(() => { if (store.db.open) store.close() })
  const user = store.findOrCreate({ provider: 'wechat_mini_program', scope: 'test-app', subject: 'openid' })
  let now = start, queries = 0, provides = 0
  const client = { query: async (o) => { queries++; return paid(o, platform) }, provide: async () => { provides++ },
    sign: (o, key) => new WechatPaymentClient(config).sign(o, key) }
  const service = new PaymentService({ userStore: store, config: { ...config }, now: () => now,
    fetchWechatSession: async () => ({ openid: 'openid', sessionKey: 'session-secret' }), client,
    logger: { warn() {} } })
  const create = async (id = 'request-number-0001') => {
    const result = await service.create(user.userId, { requestId: id, productId: 'vip_month', priceFen: 1000, code: 'code' })
    return store.payments.require(result.order.outTradeNo)
  }
  return { store, user, service, client, create, setNow: (v) => { now = v }, counts: () => ({ queries, provides }) }
}
const refund = (o, id, amount = 1000) => ({ Event: 'xpay_refund_notify', MchOrderId: o.out_trade_no,
  WxOrderId: `wx-${o.out_trade_no}`, OpenId: o.openid, WxRefundId: id, RefundFee: amount, RetCode: 0 })
const delivery = (o) => ({ Event: 'xpay_goods_deliver_notify', OpenId: o.openid,
  OutTradeNo: o.out_trade_no, Env: 0, GoodsInfo: { ProductId: o.product_id, Quantity: 1,
    OrigPrice: 1000, ActualPrice: 1000, Attach: o.attach } })

for (const orderType of [0, 7]) {
  const expectedStatuses = ['pending', 'pending', 'granted', 'granted', 'granted', 'review',
    'closed', 'granted', 'review', 'review', 'review']
  for (const [status, expected] of expectedStatuses.entries()) {
    test(`first query with order_type=${orderType}, status=${status} returns ${expected}`, async (t) => {
      const unpaid = [0, 1, 6].includes(status)
      const f = fixture(t, { platform: { order_type: orderType, status,
        paid_fee: unpaid ? 0 : 1000, left_fee: unpaid ? 0 : 1000 } }), order = await f.create()
      let changes = 0
      f.service.on('changed', () => { changes++ })
      const result = await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
      assert.equal(result.order.status, expected)
      assert.equal(result.order.platformStatus, status)
      assert.equal(result.order.priceFen, 1000)
      assert.equal(result.order.durationDays, 30)
      const granted = expected === 'granted'
      assert.equal(result.order.grantedAt, granted ? start : null)
      assert.equal(result.order.startsAt, granted ? start : null)
      assert.equal(result.order.endsAt, granted ? start + 30 * DAY_MS : null)
      assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, granted ? start + 30 * DAY_MS : 0)
      assert.equal(f.store.payments.require(order.out_trade_no).review_reason,
        expected === 'review' ? 'REFUND_AMOUNT_UNCONFIRMED' : null)
      await f.service.reconcile(order.out_trade_no, { force: true })
      assert.equal(changes, granted ? 1 : 0)
      assert.equal(f.counts().provides, granted && status !== 4 ? 1 : 0)
    })
  }

  for (const leftFee of [0, 500]) {
    for (const alreadyGranted of [false, true]) {
      test(`status=7 prioritizes left_fee=${leftFee}, order_type=${orderType}, granted=${alreadyGranted}`, async (t) => {
        const platform = { order_type: orderType, status: 7 }
        const f = fixture(t, { platform }), order = await f.create()
        if (alreadyGranted) await f.service.reconcile(order.out_trade_no)
        let changes = 0
        f.service.on('changed', () => { changes++ })
        platform.left_fee = leftFee
        f.setNow(start + DAY_MS)
        const result = await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
        assert.equal(result.order.status, leftFee === 0 ? 'refunded' : 'review')
        await f.service.reconcile(order.out_trade_no, { force: true })
        const latest = f.store.payments.require(order.out_trade_no)
        assert.equal(latest.granted_at, alreadyGranted ? start : null)
        assert.equal(latest.review_reason, leftFee === 0 ? null : 'PARTIAL_REFUND')
        assert.equal(f.store.getUser(f.user.userId).vipExpiresAt,
          alreadyGranted ? start + (leftFee === 0 ? 1 : 30) * DAY_MS : 0)
        const recorded = f.store.payments.refundById.get(`query:wx-${order.out_trade_no}:${leftFee}`)
        assert.equal(recorded.amount_fen, 1000 - leftFee)
        assert.equal(recorded.result_code, 0)
        assert.equal(changes, leftFee === 0 ? 1 : 0)
        assert.equal(f.counts().provides, alreadyGranted ? 1 : 0)
      })
    }
  }

  for (const prior of ['refunded', 'partial refund', 'manual review']) {
    test(`status=7 cannot grant after ${prior}, order_type=${orderType}`, async (t) => {
      const f = fixture(t, { platform: { status: 7, order_type: orderType } }), order = await f.create()
      if (prior === 'manual review') f.store.payments.review.run('REFUND_AMOUNT_UNCONFIRMED', order.out_trade_no)
      else await f.service.event(refund(order, 'prior-refund', prior === 'refunded' ? 1000 : 500))
      let changes = 0
      f.service.on('changed', () => { changes++ })
      const result = await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
      await f.service.reconcile(order.out_trade_no, { force: true })
      assert.equal(result.order.status, prior === 'refunded' ? 'refunded' : 'review')
      assert.equal(f.store.payments.require(order.out_trade_no).granted_at, null)
      assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
      assert.equal(f.counts().provides, 0)
      assert.equal(changes, 0)
    })
  }
}

test('failed refund notification only records its result; a validated query must confirm payment before granting', async (t) => {
  const platform = { status: 1, paid_fee: 0, left_fee: 0 }
  const f = fixture(t, { platform }), order = await f.create()
  let changes = 0
  f.service.on('changed', () => { changes++ })
  const message = { ...refund(order, 'failed-refund'), RetCode: 1 }
  assert.equal((await f.service.event(message)).ErrCode, 0)
  assert.equal(f.store.payments.refundById.get(message.WxRefundId).result_code, 1)
  assert.deepEqual(f.counts(), { queries: 0, provides: 0 })
  assert.equal((await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })).order.status, 'pending')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  assert.equal(changes, 0)
  Object.assign(platform, { status: 7, paid_fee: 1000, left_fee: 1000 })
  f.setNow(start + 2000)
  await f.service.reconcile(order.out_trade_no, { force: true })
  await f.service.event(message)
  assert.equal(f.store.payments.require(order.out_trade_no).status, 'granted')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 2000 + 30 * DAY_MS)
  assert.equal(changes, 1)
  assert.equal(f.counts().provides, 1)
})

test('default disabled, exact vip_month/1000 configuration and official HMAC vectors', () => {
  assert.equal(readPaymentConfig({}).enabled, false)
  assert.equal(readPaymentConfig({}).productId, 'vip_month')
  assert.throws(() => readPaymentConfig({ VIP_PAYMENT_ENABLED: 'true' }))
  assert.throws(() => readPaymentConfig({ VIP_PRICE_FEN: '1' }))
  const body = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}'
  assert.equal(paySignature('/xpay/query_user_balance', body, '12345'), 'c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5')
  assert.equal(hmac('9hAb/NEYUlkaMBEsmFgzig==', body), '089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7')
})

test('official JSON safe-mode sample, URL verification, encrypted response and forged/appid rejection', () => {
  const cipher = new MessageCipher({ token: 'AAAAA', appId: 'wxba5fad812f8e6fb9', aesKey: 'A'.repeat(43) })
  assert.equal(cipher.verifyUrl({ signature: 'f464b24fc39322e44b38aa78f5edd27bd1441696', timestamp: '1714036504',
    nonce: '1514711492', echostr: '4375120948345356249' }), '4375120948345356249')
  const encrypted = '+qdx1OKCy+5JPCBFWw70tm0fJGb2Jmeia4FCB7kao+/Q5c/ohsOzQHi8khUOb05JCpj0JB4RvQMkUyus8TPxLKJGQqcvZqzDpVzazhZv6JsXUnnR8XGT740XgXZUXQ7vJVnAG+tE8NUd4yFyjPy7GgiaviNrlCTj+l5kdfMuFUPpRSrfMZuMcp3Fn2Pede2IuQrKEYwKSqFIZoNqJ4M8EajAsjLY2km32IIjdf8YL/P50F7mStwntrA2cPDrM1kb6mOcfBgRtWygb3VIYnSeOBrebufAlr7F9mFUPAJGj04='
  const query = { timestamp: '1714112445', nonce: '415670741', encrypt_type: 'aes', msg_signature: '046e02f8204d34f8ba5fa3b1db94908f3df2e9b3' }
  assert.equal(cipher.decrypt(encrypted, query).debug_str, 'hello world')
  assert.throws(() => cipher.decrypt(encrypted, { ...query, msg_signature: '0'.repeat(40) }))
  assert.throws(() => new MessageCipher({ token: 'AAAAA', appId: 'wrong', aesKey: 'A'.repeat(43) }).decrypt(encrypted, query))
  const response = cipher.encrypt({ demo_resp: 'good luck' }, '415670741', 1713424427, Buffer.from('707722b803182950'))
  assert.equal(response.Encrypt, 'ELGduP2YcVatjqIS+eZbp80MNLoAUWvzzyJxgGzxZO/5sAvd070Bs6qrLARC9nVHm48Y4hyRbtzve1L32tmxSQ==')
  assert.equal(response.MsgSignature, '1b9339964ed2e271e7c7b6ff2b0ef902fc94dea1')
})

test('stable token cache coalesces requests and signs the exact query body; expiry/invalid-token retry', async () => {
  let time = 1000, tokens = 0, calls = 0, rejectToken = false
  const client = new WechatPaymentClient(config, { now: () => time, fetchImpl: async (url, options) => {
    url = new URL(url)
    const body = JSON.parse(options.body)
    if (url.pathname === '/cgi-bin/stable_token') {
      tokens++
      assert.equal(body.force_refresh, false)
      return { ok: true, json: async () => ({ access_token: `token-${tokens}`, expires_in: 7200 }) }
    }
    calls++
    assert.equal(url.searchParams.get('pay_sig'), paySignature(url.pathname, options.body, config.appKey))
    assert.equal(body.openid, 'openid')
    const errcode = rejectToken ? 40001 : 0
    rejectToken = false
    return { ok: true, json: async () => ({ errcode, order: {} }) }
  } })
  const order = { openid: 'openid', env: 0, out_trade_no: 'order' }
  await Promise.all([client.query(order), client.query(order)])
  assert.equal(tokens, 1)
  assert.equal(calls, 2)
  time += 7200000
  await client.query(order)
  assert.equal(tokens, 2)
  rejectToken = true
  await client.query(order)
  assert.equal(tokens, 3)
})

test('create binds authenticated identity, uses immutable sign data and request-id recovery never resigns', async (t) => {
  const f = fixture(t)
  const payload = { requestId: 'request-number-0001', productId: 'vip_month', priceFen: 1000, code: 'code' }
  const result = await f.service.create(f.user.userId, { ...payload, quantity: 500, env: 1, durationDays: 999 })
  assert.equal(JSON.parse(result.payment.signData).buyQuantity, 1)
  assert.equal(JSON.parse(result.payment.signData).env, 0)
  assert.equal(result.payment.signature, hmac('session-secret', result.payment.signData))
  assert.equal(JSON.stringify(f.store.payments.require(result.order.outTradeNo)).includes('session-secret'), false)
  assert.equal((await f.service.create(f.user.userId, payload)).payment, undefined)
  await assert.rejects(f.service.create(f.user.userId, { ...payload, requestId: 'request-number-0002', priceFen: 1 }), { code: 'VIP_PRICE_CHANGED' })
  f.service.fetchSession = async () => ({ openid: 'stranger', sessionKey: 'secret' })
  await assert.rejects(f.service.create(f.user.userId, { ...payload, requestId: 'request-number-0002' }), { code: 'PAYMENT_IDENTITY_MISMATCH' })
  f.service.config.enabled = false
  await assert.rejects(f.service.create(f.user.userId, { ...payload, requestId: 'request-number-0002' }), { code: 'VIP_NOT_FOR_SALE' })
})

test('query waits for a timed-out creation to settle; no cross-account order access', async (t) => {
  const f = fixture(t)
  let complete
  f.service.fetchSession = () => new Promise((resolve) => { complete = resolve })
  const create = f.create()
  const query = f.service.queryOwn(f.user.userId, { requestId: 'request-number-0001' })
  complete({ openid: 'openid', sessionKey: 'key' })
  const order = await create
  assert.equal((await query).order.outTradeNo, order.out_trade_no)
  await assert.rejects(f.service.queryOwn('stranger', { outTradeNo: order.out_trade_no }), { code: 'VIP_ORDER_NOT_FOUND' })
})

for (const status of ['granted', 'refunded', 'closed', 'review']) {
  test(`own query returns latest ${status} ledger result on platform failure without changing reconciliation errors`, async (t) => {
    const f = fixture(t), order = await f.create(), logs = []
    if (status === 'granted') await f.service.reconcile(order.out_trade_no)
    if (status === 'refunded') {
      await f.service.event(refund(order, 'fallback-refund'))
      f.store.payments.review.run('PARTIAL_REFUND', order.out_trade_no)
    }
    if (status === 'closed') f.store.payments.closeOrder.run(order.out_trade_no)
    if (status === 'review') f.store.payments.review.run('REFUND_AMOUNT_UNCONFIRMED', order.out_trade_no)
    const failure = Object.assign(new Error('sensitive upstream message'), { code: 'PAYMENT_UNAVAILABLE' })
    let queries = 0
    f.client.query = async () => { queries++; throw failure }
    f.service.logger.warn = (...args) => logs.push(args)
    f.setNow(start + 3000)
    for (const payload of [{ outTradeNo: order.out_trade_no }, { requestId: order.request_id }, {}]) {
      const result = await f.service.queryOwn(f.user.userId, payload)
      assert.equal(result.order.status, status)
      assert.deepEqual(result.order, publicOrder(f.store.payments.require(order.out_trade_no)))
    }
    assert.equal(queries, 3, 'confirmed ledger must still attempt platform reconciliation')
    assert.deepEqual(logs, Array.from({ length: 3 }, () => ['[vip-payment]', {
      order: order.out_trade_no, code: failure.code,
    }]))
    await assert.rejects(f.service.reconcile(order.out_trade_no, { force: true }), (error) => error === failure)
    await assert.rejects(f.service.event(delivery(order)), (error) => error === failure)
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, status === 'granted' ? start + 30 * DAY_MS : 0)
  })
}

for (const status of [2, 7]) {
  test(`status=${status}: own query returns a grant committed before failed acknowledgement; scheduled retry never grants twice`, async (t) => {
    const f = fixture(t, { platform: { status } }), order = await f.create(), logs = []
    let provides = 0, changes = 0
    f.service.logger.warn = (...args) => logs.push(args)
    f.service.on('changed', () => { changes++ })
    f.client.provide = async () => { provides++; throw new Error('ack offline') }
    const result = await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
    assert.equal(result.order.status, 'granted')
    assert.equal(result.order.endsAt, start + 30 * DAY_MS)
    let latest = f.store.payments.require(order.out_trade_no)
    assert.equal(latest.delivery_ack_at, null)
    assert.equal(latest.next_check_at, start + RETRY_MS)
    assert.deepEqual(logs, [['[vip-payment]', { order: order.out_trade_no, code: 'PAYMENT_ERROR' }]])
    await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
    await f.service.sweep()
    assert.equal(provides, 2, 'background must wait for the scheduled retry')
    f.setNow(start + RETRY_MS)
    await f.service.sweep()
    assert.equal(provides, 3)
    latest = f.store.payments.require(order.out_trade_no)
    assert.equal(latest.last_error, 'PAYMENT_ERROR')
    assert.equal(latest.next_check_at, start + 2 * RETRY_MS)
    f.client.provide = async () => { provides++ }
    f.setNow(start + 2 * RETRY_MS)
    await f.service.sweep()
    await f.service.reconcile(order.out_trade_no, { force: true })
    latest = f.store.payments.require(order.out_trade_no)
    assert.equal(latest.delivery_ack_at, start + 2 * RETRY_MS)
    assert.equal(latest.next_check_at, start + 2 * RETRY_MS + DAY_MS)
    assert.equal(latest.last_error, null)
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
    assert.equal(provides, 4)
    assert.equal(changes, 1)
  })
}

test('failed query rereads a refund committed by another service while its platform request was in flight', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wodi-payment-query-'))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const filename = join(dir, 'users.sqlite'), f = fixture(t, { filename }), order = await f.create()
  await f.service.reconcile(order.out_trade_no)
  const other = fixture(t, { filename })
  f.setNow(start + DAY_MS); other.setNow(start + DAY_MS)
  let rejectQuery, entered
  const querying = new Promise((resolve) => { entered = resolve })
  f.client.query = () => new Promise((resolve, reject) => { rejectQuery = reject; entered() })
  const pending = f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
  await querying
  await other.service.event(refund(order, 'concurrent-refund'))
  rejectQuery(new Error('offline'))
  const result = await pending
  assert.equal(result.order.status, 'refunded')
  assert.equal(result.order.refundedAt, start + DAY_MS)
  assert.equal(result.order.endsAt, start + DAY_MS)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + DAY_MS)
})

test('pending, invalid amount and unauthorized queries never fall back to success', async (t) => {
  const f = fixture(t), order = await f.create()
  const failure = Object.assign(new Error('offline'), { code: 'PAYMENT_UNAVAILABLE' })
  let queries = 0
  f.client.query = async () => { queries++; throw failure }
  await assert.rejects(f.service.queryOwn('stranger', { outTradeNo: order.out_trade_no }), { code: 'VIP_ORDER_NOT_FOUND' })
  assert.equal(queries, 0)
  await assert.rejects(f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no }), (error) => error === failure)
  f.client.query = async (o) => paid(o, { paid_fee: 1 })
  await assert.rejects(f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no }), { code: 'PAYMENT_AMOUNT_MISMATCH' })
  assert.equal(f.store.payments.require(order.out_trade_no).status, 'pending')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
})

test('database failures during grant, initial read and fallback read remain errors', async (t) => {
  const f = fixture(t), order = await f.create()
  f.store.db.exec("CREATE TRIGGER fail_vip BEFORE UPDATE OF vip_expires_at ON users BEGIN SELECT RAISE(ABORT, 'test'); END")
  await assert.rejects(f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no }), { code: 'SQLITE_CONSTRAINT_TRIGGER' })
  assert.equal(f.store.payments.require(order.out_trade_no).status, 'pending')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  f.store.db.exec('DROP TRIGGER fail_vip')
  await f.service.reconcile(order.out_trade_no)
  f.setNow(start + 3000)
  let queries = 0
  f.client.query = async () => { queries++; f.store.close(); throw new Error('offline') }
  await assert.rejects(f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no }), /database connection is not open/)
  await assert.rejects(f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no }), /database connection is not open/)
  assert.equal(queries, 1)
})

for (const status of [2, 7]) {
  for (const first of ['own', 'notification', 'sweep', 'manual']) {
    test(`status=${status}: ${first} first, then concurrent entries grant once for iOS while off-sale`, async (t) => {
      const f = fixture(t, { platform: { status, order_type: 7 } }), order = await f.create()
      let changes = 0
      f.service.on('changed', () => { changes++ })
      f.service.config.enabled = false
      const entries = {
        own: () => f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no }),
        notification: () => f.service.event(delivery(order)),
        sweep: () => f.service.sweep(),
        manual: () => f.service.reconcile(order.out_trade_no, { force: true }),
      }
      // Queue all entry points before the first platform response completes.
      await Promise.all([entries[first](), ...Object.values(entries).map((run) => run())])
      assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
      assert.equal(f.counts().provides, 1)
      assert.equal(changes, 1)
      assert.equal(f.store.payments.require(order.out_trade_no).delivery_ack_at, start)
      const second = f.store.payments.create(f.user.userId, 'request-number-0002', 'openid', config, start)
      await f.service.reconcile(second.out_trade_no)
      assert.equal(f.store.payments.require(second.out_trade_no).starts_at, start + 30 * DAY_MS)
      assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 60 * DAY_MS)
      assert.equal(changes, 2)
    })
  }
}

for (const status of [2, 7]) {
  test(`status=${status}: invalid amount, ownership, product, quantity and env never grant; platform ids unique`, async (t) => {
    const f = fixture(t, { platform: { status } }), order = await f.create()
    for (const patch of [{ OpenId: 'wrong' }, { Env: 1 }, { GoodsInfo: { ...delivery(order).GoodsInfo, Quantity: 2 } },
      { GoodsInfo: { ...delivery(order).GoodsInfo, ProductId: 'wrong' } }, { GoodsInfo: { ...delivery(order).GoodsInfo, ActualPrice: 1 } },
      { GoodsInfo: { ...delivery(order).GoodsInfo, OrigPrice: 1 } }, { GoodsInfo: { ...delivery(order).GoodsInfo, Attach: 'wrong' } }]) {
      await assert.rejects(f.service.event({ ...delivery(order), ...patch }), { code: 'DELIVERY_MISMATCH' })
    }
    for (const patch of [{ paid_fee: 1 }, { order_fee: 1 }, { env_type: 2 }, { order_id: 'wrong' }, { order_type: 8 },
      { wx_order_id: '' }, { left_fee: -1 }, { left_fee: 1001 }, { left_fee: 1.5 }, { left_fee: '1000' },
      { paid_fee: 0 }, { paid_fee: '1000' }, { status: -1 }, { status: 11 }, { status: '7' }]) {
      f.client.query = async (o) => paid(o, { status, ...patch })
      await assert.rejects(f.service.reconcile(order.out_trade_no, { force: true }))
      assert.equal(f.store.payments.require(order.out_trade_no).granted_at, null)
      assert.equal(f.counts().provides, 0)
    }
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
    f.client.query = async (o) => paid(o, { status, wx_order_id: 'same-platform-order' })
    await f.service.reconcile(order.out_trade_no, { force: true })
    const second = await f.create('request-number-0002')
    await assert.rejects(f.service.reconcile(second.out_trade_no))
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
  })
}

for (const status of [2, 7]) {
  test(`status=${status}: grant failure rolls back entitlement and ledger, restart retries only failed delivery acknowledgement`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'wodi-payment-'))
    t.after(() => rmSync(dir, { force: true, recursive: true }))
    const filename = join(dir, 'users.sqlite'), f = fixture(t, { filename, platform: { status } }), order = await f.create()
    f.store.db.exec("CREATE TRIGGER fail_vip BEFORE UPDATE OF vip_expires_at ON users BEGIN SELECT RAISE(ABORT, 'test'); END")
    await assert.rejects(f.service.reconcile(order.out_trade_no))
    assert.equal(f.store.payments.require(order.out_trade_no).granted_at, null)
    assert.equal(f.store.payments.require(order.out_trade_no).status, 'pending')
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
    assert.equal(f.counts().provides, 0)
    f.store.db.exec('DROP TRIGGER fail_vip')
    f.client.provide = async () => { throw new Error('offline') }
    await assert.rejects(f.service.reconcile(order.out_trade_no))
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
    f.store.close()
    const restored = fixture(t, { filename, platform: { status } })
    restored.setNow(start + 6 * 60000)
    await restored.service.sweep()
    await restored.service.reconcile(order.out_trade_no, { force: true })
    assert.equal(restored.counts().provides, 1)
    assert.equal(restored.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
    assert.ok(restored.store.payments.require(order.out_trade_no).delivery_ack_at)
  })
}

const HOUR_MS = 60 * 60 * 1000
const RETRY_MS = 5 * 60 * 1000
for (const [age, interval] of [[0, RETRY_MS], [HOUR_MS - 1, RETRY_MS], [HOUR_MS, HOUR_MS],
  [DAY_MS - 1, HOUR_MS], [DAY_MS, DAY_MS], [365 * DAY_MS, DAY_MS]]) {
  for (const fails of [false, true]) {
    test(`pending order aged ${age}ms schedules ${interval}ms after ${fails ? 'query failure' : 'unpaid response'}`, async (t) => {
      const f = fixture(t), order = await f.create()
      const now = start + age
      let queries = 0
      f.setNow(now)
      f.client.query = async (o) => {
        queries++
        if (fails) throw Object.assign(new Error('offline'), { code: 'OFFLINE' })
        return paid(o, { status: 1, paid_fee: 0, left_fee: 0 })
      }
      await f.service.sweep()
      const latest = f.store.payments.require(order.out_trade_no)
      assert.equal(queries, 1)
      assert.equal(latest.status, 'pending')
      assert.equal(latest.last_checked_at, now)
      assert.equal(latest.next_check_at, now + interval)
      assert.equal(latest.last_error, fails ? 'OFFLINE' : null)
      assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
      f.setNow(now + interval - 1)
      await f.service.sweep()
      assert.equal(queries, 1)
      f.setNow(now + interval)
      await f.service.sweep()
      assert.equal(queries, 2)
    })
  }
}

test('pending scheduling uses completion time across age boundaries', async (t) => {
  const f = fixture(t), order = await f.create()
  f.setNow(start + HOUR_MS - 1)
  f.client.query = async (o) => {
    f.setNow(start + HOUR_MS)
    return paid(o, { status: 0 })
  }
  await f.service.reconcile(order.out_trade_no)
  assert.equal(f.store.payments.require(order.out_trade_no).next_check_at, start + 2 * HOUR_MS)
  f.setNow(start + DAY_MS - 1)
  f.client.query = async () => { f.setNow(start + DAY_MS); throw new Error('offline') }
  await assert.rejects(f.service.reconcile(order.out_trade_no))
  assert.equal(f.store.payments.require(order.out_trade_no).next_check_at, start + 2 * DAY_MS)
})

for (const status of [2, 7]) {
  test(`status=${status}: old pending failure keeps daily due date across restart and grants a late payment once`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'wodi-payment-backoff-'))
    t.after(() => rmSync(dir, { force: true, recursive: true }))
    const filename = join(dir, 'users.sqlite'), f = fixture(t, { filename, platform: { status } }), order = await f.create()
    const now = start + 365 * DAY_MS
    f.setNow(now)
    f.client.query = async () => { throw new Error('not submitted') }
    await f.service.sweep()
    f.store.close()
    const restored = fixture(t, { filename, platform: { status } })
    restored.setNow(now + DAY_MS - 1)
    await restored.service.sweep()
    assert.equal(restored.counts().queries, 0)
    restored.setNow(now + DAY_MS)
    await restored.service.sweep()
    await restored.service.event(delivery(order))
    await restored.service.reconcile(order.out_trade_no, { force: true })
    assert.equal(restored.store.getUser(f.user.userId).vipExpiresAt, now + 31 * DAY_MS)
    assert.equal(restored.counts().provides, 1)
  })
}

test('active query, notification and manual reconciliation bypass backoff; page queries still coalesce for two seconds', async (t) => {
  const f = fixture(t), order = await f.create(), now = start + 2 * DAY_MS
  let queries = 0
  f.setNow(now)
  f.client.query = async (o) => { queries++; return paid(o, { status: 1 }) }
  await f.service.sweep()
  await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
  assert.equal(queries, 1)
  f.setNow(now + 2000)
  await f.service.queryOwn(f.user.userId, { outTradeNo: order.out_trade_no })
  assert.equal(queries, 2)
  await f.service.sweep()
  assert.equal(queries, 2)
  f.client.query = async (o) => { queries++; return paid(o) }
  await f.service.event(delivery(order))
  assert.equal(queries, 3)
  await f.service.reconcile(order.out_trade_no, { force: true })
  assert.equal(queries, 4)
  assert.equal(f.counts().provides, 1)
})

test('late grant with failed platform acknowledgement retries every five minutes, then checks refunds daily even on query failure', async (t) => {
  const f = fixture(t), order = await f.create(), now = start + 365 * DAY_MS
  let provides = 0
  f.setNow(now)
  f.client.provide = async () => { provides++; throw new Error('ack offline') }
  await f.service.sweep()
  const granted = f.store.payments.require(order.out_trade_no)
  assert.equal(granted.status, 'granted')
  assert.equal(granted.delivery_ack_at, null)
  assert.equal(granted.next_check_at, now + RETRY_MS)
  f.setNow(now + RETRY_MS)
  await f.service.sweep()
  assert.equal(provides, 2)
  assert.equal(f.store.payments.require(order.out_trade_no).next_check_at, now + 2 * RETRY_MS)
  f.client.provide = async () => { provides++ }
  f.setNow(now + 2 * RETRY_MS)
  await f.service.sweep()
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, now + 30 * DAY_MS)
  assert.equal(f.store.payments.require(order.out_trade_no).next_check_at, now + 2 * RETRY_MS + DAY_MS)
  f.client.query = async () => { throw new Error('refund query offline') }
  f.setNow(now + 2 * RETRY_MS + DAY_MS)
  await f.service.sweep()
  assert.equal(f.store.payments.require(order.out_trade_no).next_check_at, now + 2 * RETRY_MS + 2 * DAY_MS)
  assert.equal(provides, 3)
})

test('refund before delivery prevents granting; failed and partial refunds never revoke a full order', async (t) => {
  const f = fixture(t), first = await f.create()
  await f.service.event(refund(first, 'refund-first'))
  await f.service.reconcile(first.out_trade_no)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  const next = await f.create('request-number-0002')
  await f.service.reconcile(next.out_trade_no)
  await f.service.event({ ...refund(next, 'failed'), RetCode: 1 })
  await f.service.event(refund(next, 'partial', 500))
  await f.service.event(refund(next, 'partial', 500))
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
  assert.equal(f.store.payments.require(next.out_trade_no).review_reason, 'PARTIAL_REFUND')
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM vip_refunds').get().n, 3)
})

test('refunds adjust later renewal intervals; consumed old orders do not consume other orders', async (t) => {
  const f = fixture(t), a = await f.create(), b = await f.create('request-number-0002'), c = await f.create('request-number-0003')
  for (const order of [a, b, c]) await f.service.reconcile(order.out_trade_no)
  f.setNow(start + 10 * DAY_MS)
  await f.service.event(refund(a, 'refund-a'))
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 70 * DAY_MS)
  assert.equal(f.store.payments.require(b.out_trade_no).starts_at, start + 10 * DAY_MS)
  assert.equal(f.store.payments.require(c.out_trade_no).starts_at, start + 40 * DAY_MS)
  await f.service.event(refund(a, 'refund-a'))
  f.setNow(start + 50 * DAY_MS)
  await f.service.event(refund(b, 'refund-b'))
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 70 * DAY_MS)
  await f.service.event(refund(c, 'refund-c'))
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 50 * DAY_MS)
})

test('refund transaction rollback, retained legacy VIP and future renewal refund', async (t) => {
  const f = fixture(t)
  f.store.db.prepare('UPDATE users SET vip_expires_at=? WHERE user_id=?').run(start + 10 * DAY_MS, f.user.userId)
  const a = await f.create(), b = await f.create('request-number-0002')
  await f.service.reconcile(a.out_trade_no); await f.service.reconcile(b.out_trade_no)
  f.store.db.exec("CREATE TRIGGER fail_vip BEFORE UPDATE OF vip_expires_at ON users BEGIN SELECT RAISE(ABORT, 'test'); END")
  await assert.rejects(f.service.event(refund(a, 'refund-atomic')))
  assert.equal(f.store.payments.refundById.get('refund-atomic'), undefined)
  assert.equal(f.store.payments.require(b.out_trade_no).starts_at, start + 40 * DAY_MS)
  f.store.db.exec('DROP TRIGGER fail_vip')
  await f.service.event(refund(a, 'refund-atomic'))
  await f.service.event(refund(b, 'refund-b'))
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 10 * DAY_MS)
})

test('daily reconciliation catches full refund; iOS inquiry uses actual usage', async (t) => {
  const f = fixture(t), a = await f.create()
  await f.service.reconcile(a.out_trade_no)
  const inquiry = { Event: 'xpay_subscribe_ios_refund_query_notify', pay_order_id: a.out_trade_no, product_id: 'vip_month', p_count: '1' }
  assert.equal((await f.service.event(inquiry)).result_code, 0)
  f.setNow(start + DAY_MS)
  assert.equal((await f.service.event(inquiry)).result_code, 1)
  f.client.query = async (o) => paid(o, { status: 5, left_fee: 0 })
  await f.service.sweep()
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + DAY_MS)
  assert.equal((await f.service.event(inquiry)).result_code, 0)
})

test('authenticated socket + encrypted HTTP delivery/refund update membership and room without avatar replacement', async () => {
  const f = await createFixture(':memory:', { payment: { config,
    fetchWechatSession: async (code) => ({ openid: `verified-${code}`, sessionKey: 'key' }),
    client: { query: async (o) => paid(o), provide: async () => {}, sign: (o, key) => new WechatPaymentClient(config).sign(o, key) } } })
  try {
    const account = await f.login('buyer'), other = await f.login('other')
    assert.equal(account.membership.productId, 'vip_month')
    assert.equal(account.membership.purchasable, true)
    const buyer = await f.connect({ token: account.token }), stranger = await f.connect({ token: other.token })
    const room = await request(buyer.socket, 'room:create', { playMode: 'language' })
    await request(stranger.socket, 'room:join', { roomId: room.room.roomId })
    const orderResponse = await request(buyer.socket, 'user:createVipOrder', { code: 'buyer', requestId: 'socket-request-0001', productId: 'vip_month', priceFen: 1000 })
    assert.equal(orderResponse.ok, true)
    const order = f.userStore.payments.require(orderResponse.order.outTradeNo)
    assert.equal((await request(stranger.socket, 'user:queryVipOrder', { outTradeNo: order.out_trade_no })).ok, false)
    const cipher = new MessageCipher(config)
    async function post(message, forged = false) {
      const envelope = cipher.encrypt(message)
      const query = new URLSearchParams({ timestamp: String(envelope.TimeStamp), nonce: envelope.Nonce, encrypt_type: 'aes',
        msg_signature: forged ? '0'.repeat(40) : envelope.MsgSignature })
      return fetch(`${f.url}/wechat/events?${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
    }
    assert.equal((await post(delivery(order), true)).status, 403)
    const delivered = await post(delivery(order))
    assert.equal(delivered.status, 200)
    const body = await delivered.json()
    assert.equal(cipher.decrypt(body.Encrypt, { timestamp: String(body.TimeStamp), nonce: body.Nonce, encrypt_type: 'aes', msg_signature: body.MsgSignature }).ErrCode, 0)
    const latest = await request(buyer.socket, 'user:syncState')
    assert.equal(latest.membership.isVip, true)
    assert.equal(latest.profile.avatar, account.profile.avatar)
    assert.equal(f.manager.getRoomState(room.room.roomId).players[0].isVip, true)
    await request(buyer.socket, 'user:updateProfile', { nickname: '会员', avatar: '/assets/avatars/avatar-9.svg' })
    assert.equal((await post(refund(order, 'socket-refund'))).status, 200)
    const refunded = await request(buyer.socket, 'user:syncState')
    assert.equal(refunded.membership.isVip, false)
    assert.equal(refunded.profile.avatar, account.profile.avatar)
    assert.equal(f.manager.getRoomState(room.room.roomId).players[0].isVip, false)
    const echoQuery = new URLSearchParams({ timestamp: '123', nonce: 'n', echostr: 'echo', signature: signature(config.token, '123', 'n') })
    assert.equal(await (await fetch(`${f.url}/wechat/events?${echoQuery}`)).text(), 'echo')
  } finally { await f.close() }
})

async function paymentSocketFixture() {
  return createFixture(':memory:', { payment: { config,
    fetchWechatSession: async (code) => ({ openid: `verified-${code}`, sessionKey: 'key' }),
    client: { query: async (o) => paid(o), provide: async () => {},
      sign: (o, key) => new WechatPaymentClient(config).sign(o, key) } } })
}

async function purchase(f, socket, id) {
  const created = await request(socket, 'user:createVipOrder', {
    code: 'buyer', requestId: id, productId: 'vip_month', priceFen: 1000,
  })
  assert.equal(created.ok, true)
  const result = await request(socket, 'user:queryVipOrder', { outTradeNo: created.order.outTradeNo })
  assert.equal(result.ok, true)
  assert.equal(result.membership.isVip, true)
  return f.userStore.payments.require(created.order.outTradeNo)
}

for (const phase of ['waiting', 'dealing']) {
  for (const renewal of [false, true]) {
    test(`offline refund synchronizes ${phase} broadcasts, snapshots and reconnect with renewal=${renewal}`, async () => {
      const f = await paymentSocketFixture()
      try {
        const account = await f.login('buyer'), observerAccount = await f.login('observer')
        const buyer = await f.connect({ token: account.token }), observer = await f.connect({ token: observerAccount.token })
        const normal = '/assets/avatars/avatar-3.svg', vip = '/assets/avatars/avatar-9.svg'
        await request(buyer.socket, 'user:updateProfile', { nickname: '会员', avatar: normal })
        const first = await purchase(f, buyer.socket, 'offline-first-order')
        const second = renewal ? await purchase(f, buyer.socket, 'offline-renewal-order') : null
        await request(buyer.socket, 'user:updateProfile', { nickname: '会员', avatar: vip })
        const created = await request(buyer.socket, 'room:create', { playMode: 'language' })
        const roomId = created.room.roomId
        await request(observer.socket, 'room:join', { roomId })
        await fillRoom(f, f.manager.getRoomIdForPlayer(buyer.playerId))
        if (phase === 'dealing') assert.equal((await request(buyer.socket, 'room:startGame', { playMode: 'language' })).ok, true)
        const serverSocket = f.io.sockets.sockets.get(buyer.socket.id)
        const disconnected = new Promise((resolve) => serverSocket.once('disconnect', resolve))
        buyer.socket.disconnect()
        await disconnected
        await request(observer.socket, 'user:syncState')
        const room = f.manager.rooms.get(roomId), registry = f.manager.sessionRegistry
        const session = registry.get(buyer.playerId), originalSession = { ...session }
        const retained = { lastActivityAt: room.lastActivityAt, idleTimer: room.idleTimer,
          idleWarningTimer: room.idleWarningTimer, hostTransferTimer: room.hostTransferTimer,
          hostTransferPlayerId: room.hostTransferPlayerId }
        const rooms = [], games = [], privateStates = []
        observer.socket.on('room:state', (data) => rooms.push(data.room))
        observer.socket.on('game:stateSync', (data) => games.push(data))
        // Barrier ACKs use user:syncState; record only the refunded user's private state.
        observer.socket.on('user:state', (data) => { if (data.userId === account.userId) privateStates.push(data) })
        await f.paymentService.event(refund(first, 'offline-refund-first'))
        await request(observer.socket, 'user:syncState')
        assert.equal(rooms.length, 1)
        assert.equal(games.length, phase === 'dealing' ? 1 : 0)
        const expectedAvatar = renewal ? vip : normal
        const checkPlayer = (snapshot) => {
          const player = snapshot.players.find((p) => p.id === buyer.playerId)
          assert.equal(player.avatar, expectedAvatar)
          assert.equal(player.isVip, renewal)
          assert.equal(player.disconnected, true)
          assert.equal(player.isHost, true)
        }
        checkPlayer(rooms[0])
        checkPlayer(f.manager.getRoomState(roomId))
        if (phase === 'dealing') {
          checkPlayer(games[0]); checkPlayer(f.manager.getGamePublicState(roomId))
          assert.equal(room.gameState.playerRoster.find((p) => p.id === buyer.playerId).avatar, expectedAvatar)
        }
        assert.deepEqual(session, originalSession)
        for (const [key, value] of Object.entries(retained)) assert.equal(room[key], value, key)
        assert.equal(privateStates.length, 0)
        const user = f.userStore.getUser(account.userId)
        assert.equal(user.isVip, renewal)
        assert.equal(user.avatar, expectedAvatar)
        assert.equal(f.userStore.db.prepare('SELECT avatar FROM users WHERE user_id = ?').get(account.userId).avatar, expectedAvatar)
        if (renewal) {
          const remaining = f.userStore.payments.require(second.out_trade_no)
          assert.equal(remaining.ends_at, user.vipExpiresAt)
          assert.equal(remaining.ends_at - remaining.starts_at, 30 * DAY_MS)
          assert.ok(remaining.ends_at < second.ends_at)
        }
        await f.paymentService.event(refund(first, 'offline-refund-first'))
        await request(observer.socket, 'user:syncState')
        assert.equal(rooms.length, 1, 'duplicate refund must not broadcast again')
        assert.equal(games.length, phase === 'dealing' ? 1 : 0)
        assert.deepEqual(f.userStore.getUser(account.userId), user)
        const reconnected = await f.connect({ token: account.token })
        assert.equal(reconnected.playerId, buyer.playerId)
        assert.equal(reconnected.profile.avatar, expectedAvatar)
        assert.equal(reconnected.membership.isVip, renewal)
        const synced = await request(reconnected.socket, 'room:syncState')
        assert.equal(synced.ok, true)
        assert.equal(synced.room.players.find((p) => p.id === buyer.playerId).avatar, expectedAvatar)
        assert.equal(synced.room.players.find((p) => p.id === buyer.playerId).disconnected, false)
      } finally { await f.close() }
    })
  }
}

test('one service listener survives repeated connections; online changes broadcast once and close removes it', async (t) => {
  const f = await paymentSocketFixture()
  try {
    const account = await f.login('buyer'), other = await f.login('observer')
    let buyer = await f.connect({ token: account.token })
    const observer = await f.connect({ token: other.token })
    const created = await request(buyer.socket, 'room:create', { playMode: 'language' })
    await request(observer.socket, 'room:join', { roomId: created.room.roomId })
    await fillRoom(f, f.manager.getRoomIdForPlayer(buyer.playerId))
    await request(buyer.socket, 'room:startGame', { playMode: 'language' })
    for (let i = 0; i < 12; i += 1) {
      buyer = await f.connect({ token: account.token })
      assert.equal(f.paymentService.listenerCount('changed'), 1)
    }
    await request(observer.socket, 'user:syncState')
    const rooms = [], games = [], states = [], expiryTimers = [], cleared = []
    observer.socket.on('room:state', (data) => rooms.push(data))
    observer.socket.on('game:stateSync', (data) => games.push(data))
    buyer.socket.on('user:state', (data) => states.push(data))
    const originalTimeout = global.setTimeout, originalClear = global.clearTimeout
    t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
      const timer = originalTimeout(callback, ms, ...args)
      if (ms > DAY_MS) expiryTimers.push(timer)
      return timer
    })
    t.mock.method(global, 'clearTimeout', (timer) => { cleared.push(timer); return originalClear(timer) })
    const first = await purchase(f, buyer.socket, 'online-listener-order')
    await request(observer.socket, 'user:syncState')
    assert.equal(rooms.length, 1)
    assert.equal(games.length, 1)
    assert.equal(states.at(-1).membership.isVip, true)
    const active = f.io.sockets.sockets.get(buyer.socket.id)
    assert.equal(active.data.profile.isVip, true)
    assert.ok(expiryTimers.length > 0)
    await f.paymentService.event(refund(first, 'online-listener-refund'))
    await request(buyer.socket, 'user:syncState')
    await request(observer.socket, 'user:syncState')
    assert.equal(rooms.length, 2)
    assert.equal(games.length, 2)
    assert.equal(states.at(-1).membership.isVip, false)
    assert.equal(active.data.profile.isVip, false)
    assert.ok(expiryTimers.every((timer) => cleared.includes(timer)))
    await purchase(f, buyer.socket, 'online-next-order')
    const latestTimer = expiryTimers.at(-1)
    assert.equal(cleared.includes(latestTimer), false)
    const disconnected = new Promise((resolve) => active.once('disconnect', resolve))
    buyer.socket.disconnect()
    await disconnected
    assert.ok(cleared.includes(latestTimer), 'disconnect must clear expiry timer')
    assert.equal(f.paymentService.listenerCount('changed'), 1)
  } finally { await f.close() }
  assert.equal(f.paymentService.listenerCount('changed'), 0)
})

test('payment changes never create sessions or refresh detached-session retention', async () => {
  const f = await paymentSocketFixture()
  try {
    const user = f.userStore.findOrCreate({ provider: 'wechat_mini_program', scope: 'test-app', subject: 'no-session' })
    const registry = f.manager.sessionRegistry
    assert.equal(registry.sessions.size, 0)
    f.paymentService.emit('changed', user.userId)
    assert.equal(registry.sessions.size, 0)
    assert.equal(registry.identityToPlayer.size, 0)
    const account = await f.login('detached')
    const session = registry.get(account.playerId), before = { ...session }
    f.paymentService.emit('changed', account.userId)
    assert.deepEqual(session, before)
    assert.equal(registry.sessions.size, 1)
    assert.equal(f.manager.rooms.size, 0)
  } finally { await f.close() }
})
