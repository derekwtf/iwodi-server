const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { Worker } = require('node:worker_threads')
const Database = require('better-sqlite3')
const UserStore = require('../src/user/UserStore')
const PaymentLedger = require('../src/payment/PaymentLedger')
const AppPaymentLedger = require('../src/payment/AppPaymentLedger')
const { DAY_MS } = require('../src/payment/config')

const start = Date.UTC(2026, 0, 1)
const config = { platform: 'ios', environment: 'sandbox', appId: 'app.test', storeProductId: 'vip.30days', productId: 'vip_month', durationDays: 30 }
function fixture(t, filename = ':memory:') {
  const store = new UserStore(filename)
  const ledger = new AppPaymentLedger(store.db)
  const user = store.findOrCreate({ provider: 'apple', scope: 'app.test', subject: 'buyer' })
  t.after(() => { if (store.db.open) store.close() })
  const create = (request = 'request-1', extra = {}, now = start) => ledger.create(user.userId, request, { ...config, ...extra }, now)
  const grant = (order, now = start) => {
    ledger.grantVerified(order.out_trade_no, verified(order), now)
    ledger.markFinished(order.out_trade_no, now)
    return ledger.require(order.out_trade_no)
  }
  return { store, ledger, user, create, grant }
}
function verified(order, extra = {}) {
  return { platform: order.platform, environment: order.environment, appId: order.app_id,
    storeProductId: order.store_product_id, accountToken: order.account_token, quantity: 1,
    transactionId: `store-${order.out_trade_no}`, status: 'purchased', purchasedAt: start,
    currency: 'USD', amountMicros: '1990000', ...extra }
}
function refund(order, refundId, extra = {}) {
  return verified(order, { status: 'refunded', refundId, source: 'notification', refundedAt: start + DAY_MS, ...extra })
}
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'iwodi-app-ledger-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('create is request-idempotent, binds a fresh account UUID and blocks unknown or unfinished purchases', (t) => {
  const f = fixture(t), order = f.create()
  assert.match(order.account_token, /^[0-9a-f-]{36}$/)
  assert.equal(f.create().out_trade_no, order.out_trade_no)
  assert.throws(() => f.create('request-2'), { code: 'VIP_ORDER_PENDING' })
  assert.throws(() => f.create('request-2', { platform: 'android' }), { code: 'VIP_ORDER_PENDING' })
  f.ledger.grantVerified(order.out_trade_no, verified(order), start)
  assert.throws(() => f.create('request-2'), { code: 'VIP_ORDER_PENDING' })
  assert.equal(f.ledger.markFinished(order.out_trade_no, start), true)
  assert.equal(f.ledger.markFinished(order.out_trade_no, start + 1), false)
  const next = f.create('request-2')
  assert.notEqual(next.out_trade_no, order.out_trade_no)
  assert.notEqual(next.account_token, order.account_token)
  assert.equal(next.product_id, 'vip_month')
  assert.equal(next.duration_ms, 30 * DAY_MS)
  assert.equal(next.amount_micros, null)
  assert.equal(next.currency, null)
  assert.equal(Object.hasOwn(next, 'openid'), false)
  assert.equal(Object.hasOwn(next, 'price_fen'), false)
  assert.equal(f.ledger.byAccountToken.get('ios', 'sandbox', next.account_token).out_trade_no, next.out_trade_no)
})

test('verified store identity and quantity must match; foreign transactions cannot move between users or requests', (t) => {
  const f = fixture(t), order = f.create()
  for (const extra of [{ platform: 'android' }, { environment: 'production' }, { appId: 'wrong' },
    { storeProductId: 'wrong' }, { quantity: 2 }, { accountToken: 'another-account' },
    { amountMicros: 1990000 }, { currency: 'invalid' }]) {
    assert.throws(() => f.ledger.grantVerified(order.out_trade_no, verified(order, extra), start))
    assert.equal(f.ledger.require(order.out_trade_no).transaction_id, null)
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  }
  f.grant(order)
  const anotherUser = f.store.findOrCreate({ provider: 'apple', scope: 'app.test', subject: 'other-buyer' })
  const another = f.ledger.create(anotherUser.userId, 'other-request', config, start)
  assert.throws(() => f.ledger.grantVerified(another.out_trade_no,
    verified(another, { transactionId: verified(order).transactionId }), start), { code: 'PAYMENT_TRANSACTION_CLAIMED' })
  const next = f.create('request-2')
  assert.throws(() => f.ledger.grantVerified(next.out_trade_no,
    verified(next, { transactionId: verified(order).transactionId }), start), { code: 'PAYMENT_TRANSACTION_CLAIMED' })
  assert.equal(f.ledger.byTransaction.get('ios', 'sandbox', verified(order).transactionId).user_id, f.user.userId)
  assert.equal(f.store.getUser(anotherUser.userId).vipExpiresAt, 0)
})

test('pending purchase tokens bind one order before a store transaction ID exists', (t) => {
  const f = fixture(t), order = f.create('android-1', { platform: 'android' })
  const pending = verified(order, { transactionId: undefined, purchaseToken: 'google-pending-token', status: 'pending', currency: undefined, amountMicros: undefined })
  f.ledger.recordVerified(order.out_trade_no, pending)
  assert.equal(f.ledger.require(order.out_trade_no).purchase_token, pending.purchaseToken)
  assert.equal(f.ledger.require(order.out_trade_no).transaction_id, null)
  assert.equal(f.ledger.cancelNative(order.out_trade_no, start), false)
  assert.throws(() => f.create('another'), { code: 'VIP_ORDER_PENDING' })
  const other = f.store.findOrCreate({ provider: 'google', scope: 'app.test', subject: 'other' })
  const otherOrder = f.ledger.create(other.userId, 'other-request', { ...config, platform: 'android' }, start)
  assert.throws(() => f.ledger.recordVerified(otherOrder.out_trade_no,
    { ...pending, accountToken: otherOrder.account_token }), { code: 'PAYMENT_TRANSACTION_CLAIMED' })
  f.ledger.grantVerified(order.out_trade_no, { ...pending, transactionId: 'google-paid', status: 'purchased' }, start)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
  assert.equal(f.ledger.require(order.out_trade_no).amount_micros, null)
})

for (const reason of [undefined, 'purchase_not_started']) {
test(`${reason || 'native_cancelled'} closes only an unbound order; a late verified payment grants the original order`, (t) => {
  const f = fixture(t), order = f.create()
  assert.throws(() => f.ledger.cancelNative(order.out_trade_no, start, 'untrusted-reason'), { code: 'PAYMENT_CANCELLATION_INVALID' })
  assert.equal(f.ledger.require(order.out_trade_no).status, 'pending')
  assert.equal(f.ledger.cancelNative(order.out_trade_no, start, reason), true)
  const closed = f.ledger.require(order.out_trade_no)
  assert.equal(closed.status, 'closed')
  assert.equal(closed.closure_reason, reason || 'native_cancelled')
  assert.equal(closed.client_cancelled_at, start)
  const next = f.create('request-2')
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start), true)
  assert.equal(f.ledger.require(next.out_trade_no).status, 'pending')
  assert.equal(f.ledger.require(order.out_trade_no).status, 'granted')
  assert.equal(f.ledger.require(order.out_trade_no).closure_reason, null)
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start + 1), false)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
})
}

for (const reason of [null, 'native_cancelled', 'purchase_not_started']) {
test(`platform cancellation after ${reason || 'pending'} is terminal for late purchases and pending events`, (t) => {
  const f = fixture(t), order = f.create()
  if (reason) f.ledger.cancelNative(order.out_trade_no, start, reason)
  const cancelled = verified(order, { status: 'cancelled' })
  f.ledger.recordVerified(order.out_trade_no, cancelled)
  assert.equal(f.ledger.close(order.out_trade_no), true)
  const assertCancelled = () => {
    const current = f.ledger.require(order.out_trade_no)
    assert.equal(current.status, 'closed')
    assert.equal(current.closure_reason, 'platform_cancelled')
    assert.equal(current.platform_status, 'cancelled')
    assert.equal(current.granted_at, null)
    assert.equal(current.platform_ack_at, null)
    assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  }
  assertCancelled()
  for (let attempt = 0; attempt < 2; attempt++) {
    f.ledger.recordVerified(order.out_trade_no, verified(order, { status: 'pending' }))
    assertCancelled()
    f.ledger.recordVerified(order.out_trade_no, verified(order))
    assertCancelled()
    assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start + DAY_MS), false)
    f.ledger.recordVerified(order.out_trade_no, cancelled)
    f.ledger.close(order.out_trade_no)
    assertCancelled()
  }
  assert.equal(f.ledger.refundVerified(order.out_trade_no, refund(order, 'after-cancellation'), start + DAY_MS), true)
  assert.equal(f.ledger.require(order.out_trade_no).status, 'refunded')
  assert.equal(f.ledger.require(order.out_trade_no).platform_status, 'refunded')
  assert.equal(f.ledger.require(order.out_trade_no).revoked_ms, 0)
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start + 2 * DAY_MS), false)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
})
}

test('a recorded platform cancellation blocks delivery before closing the order', (t) => {
  const f = fixture(t), order = f.create()
  f.ledger.recordVerified(order.out_trade_no, verified(order, { status: 'cancelled' }))
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start), false)
  assert.equal(f.ledger.require(order.out_trade_no).platform_status, 'cancelled')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
})

test('platform cancellation of a granted order refunds only its remaining interval once', (t) => {
  const f = fixture(t), first = f.grant(f.create()), next = f.grant(f.create('renewal'))
  assert.equal(f.ledger.close(first.out_trade_no), false)
  const cancelled = verified(first, { status: 'cancelled' })
  assert.equal(f.ledger.refundVerified(first.out_trade_no, cancelled, start + 10 * DAY_MS), true)
  assert.equal(f.ledger.refundVerified(first.out_trade_no, cancelled, start + 11 * DAY_MS), false)
  assert.equal(f.ledger.require(first.out_trade_no).revoked_ms, 20 * DAY_MS)
  assert.equal(f.ledger.require(next.out_trade_no).starts_at, start + 10 * DAY_MS)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 40 * DAY_MS)
})

test('grant failure rolls back store identifiers and entitlement together; retry delivers exactly once', (t) => {
  const f = fixture(t), order = f.create()
  f.store.db.exec("CREATE TRIGGER fail_grant BEFORE UPDATE OF vip_expires_at ON users BEGIN SELECT RAISE(ABORT, 'test grant failure'); END")
  assert.throws(() => f.ledger.grantVerified(order.out_trade_no, verified(order), start), /test grant failure/)
  const rolledBack = f.ledger.require(order.out_trade_no)
  assert.equal(rolledBack.transaction_id, null)
  assert.equal(rolledBack.currency, null)
  assert.equal(rolledBack.status, 'pending')
  assert.equal(rolledBack.granted_at, null)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  f.store.db.exec('DROP TRIGGER fail_grant')
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start), true)
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start + DAY_MS), false)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
})

test('late grants use confirmation time and renewals extend from the existing expiry', (t) => {
  const f = fixture(t), order = f.create()
  const first = f.grant(order, start + 2 * DAY_MS)
  assert.equal(first.starts_at, start + 2 * DAY_MS)
  assert.equal(first.ends_at, start + 32 * DAY_MS)
  const next = f.grant(f.create('renewal'), start + 3 * DAY_MS)
  assert.equal(next.starts_at, first.ends_at)
  assert.equal(next.ends_at, start + 62 * DAY_MS)
})

test('full refund before delivery is terminal across duplicate and out-of-order purchase events', (t) => {
  const f = fixture(t), order = f.create()
  assert.equal(f.ledger.refundVerified(order.out_trade_no, refund(order, 'refund-first'), start + DAY_MS), true)
  assert.equal(f.ledger.refundVerified(order.out_trade_no, refund(order, 'refund-first'), start + 2 * DAY_MS), false)
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start + 3 * DAY_MS), false)
  assert.equal(f.ledger.require(order.out_trade_no).status, 'refunded')
  assert.equal(f.ledger.require(order.out_trade_no).platform_status, 'refunded')
  assert.equal(f.ledger.require(order.out_trade_no).granted_at, null)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM app_vip_refunds').get().n, 1)
})

test('failed and partial refunds do not revoke or accidentally deliver a full order', (t) => {
  const f = fixture(t), order = f.create()
  assert.equal(f.ledger.refundVerified(order.out_trade_no,
    refund(order, 'attempt', { refundResult: 'failed' }), start), false)
  assert.equal(f.ledger.require(order.out_trade_no).status, 'pending')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  assert.equal(f.ledger.refundVerified(order.out_trade_no,
    refund(order, 'partial', { refundAmountMicros: '990000' }), start), false)
  assert.equal(f.ledger.require(order.out_trade_no).review_reason, 'PARTIAL_REFUND')
  assert.equal(f.ledger.grantVerified(order.out_trade_no, verified(order), start), false)
  assert.equal(f.ledger.refundVerified(order.out_trade_no, refund(order, 'attempt'), start), true)
  assert.equal(f.ledger.refundById.get('ios', 'sandbox', 'attempt').result, 'completed')
  assert.equal(f.ledger.refundVerified(order.out_trade_no,
    refund(order, 'attempt', { refundResult: 'failed' }), start + 1), false)
  assert.equal(f.ledger.refundById.get('ios', 'sandbox', 'attempt').result, 'completed')
})

test('refunds revoke only unused time and shift later App intervals; consumed orders cannot eat renewals', (t) => {
  const f = fixture(t)
  const first = f.grant(f.create('first'))
  const second = f.grant(f.create('second'))
  const third = f.grant(f.create('third'))
  f.ledger.refundVerified(first.out_trade_no, refund(first, 'refund-first'), start + 10 * DAY_MS)
  assert.equal(f.ledger.require(first.out_trade_no).revoked_ms, 20 * DAY_MS)
  assert.equal(f.ledger.require(second.out_trade_no).starts_at, start + 10 * DAY_MS)
  assert.equal(f.ledger.require(third.out_trade_no).starts_at, start + 40 * DAY_MS)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 70 * DAY_MS)
  f.ledger.refundVerified(second.out_trade_no, refund(second, 'refund-second'), start + 45 * DAY_MS)
  assert.equal(f.ledger.require(second.out_trade_no).revoked_ms, 0)
  assert.equal(f.ledger.require(third.out_trade_no).starts_at, start + 40 * DAY_MS)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 70 * DAY_MS)
  f.ledger.refundVerified(third.out_trade_no, refund(third, 'refund-third'), start + 50 * DAY_MS)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 50 * DAY_MS)
})

test('refund of a future interval preserves prior entitlement and never rewrites the WeChat ledger', (t) => {
  const f = fixture(t)
  f.store.db.prepare('UPDATE users SET vip_expires_at = ? WHERE user_id = ?').run(start + 10 * DAY_MS, f.user.userId)
  const first = f.grant(f.create('first'))
  const second = f.grant(f.create('second'))
  const beforeWechat = f.store.db.prepare('SELECT * FROM vip_orders').all()
  f.ledger.refundVerified(first.out_trade_no, refund(first, 'future-refund'), start)
  assert.equal(f.ledger.require(first.out_trade_no).revoked_ms, 30 * DAY_MS)
  assert.equal(f.ledger.require(second.out_trade_no).starts_at, start + 10 * DAY_MS)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 40 * DAY_MS)
  assert.deepEqual(f.store.db.prepare('SELECT * FROM vip_orders').all(), beforeWechat)
})

test('refund failure rolls back receipt, later intervals and user expiry atomically', (t) => {
  const f = fixture(t), first = f.grant(f.create()), second = f.grant(f.create('second'))
  f.store.db.exec("CREATE TRIGGER fail_refund BEFORE UPDATE OF vip_expires_at ON users BEGIN SELECT RAISE(ABORT, 'test refund failure'); END")
  assert.throws(() => f.ledger.refundVerified(first.out_trade_no, refund(first, 'atomic'), start + DAY_MS), /test refund failure/)
  assert.equal(f.ledger.refundById.get('ios', 'sandbox', 'atomic'), undefined)
  assert.deepEqual(f.ledger.require(first.out_trade_no), first)
  assert.deepEqual(f.ledger.require(second.out_trade_no), second)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, second.ends_at)
  f.store.db.exec('DROP TRIGGER fail_refund')
  assert.equal(f.ledger.refundVerified(first.out_trade_no, refund(first, 'atomic'), start + DAY_MS), true)
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 31 * DAY_MS)
})

function concurrentOperations(filename, inputs) {
  return new Promise((resolveResults, reject) => {
    let ready = 0, completed = 0
    const results = []
    const fail = (error) => { workers.forEach((worker) => worker.terminate()); reject(error) }
    const workers = inputs.map((input, index) => {
      const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const Database = require(workerData.databaseModule)
      const Ledger = require(workerData.ledgerModule)
      const db = new Database(workerData.filename)
      db.pragma('foreign_keys = ON')
      const ledger = new Ledger(db)
      parentPort.postMessage({ ready: true })
      parentPort.once('message', () => {
        try {
          const value = workerData.input.kind === 'grant'
            ? ledger.grantVerified(...workerData.input.args)
            : ledger.create(...workerData.input.args).out_trade_no
          parentPort.postMessage({ value })
        } catch (error) { parentPort.postMessage({ error: error.code || error.message }) }
        finally { db.close() }
      })
    `, { eval: true, workerData: { filename, input,
      databaseModule: require.resolve('better-sqlite3'), ledgerModule: resolve(__dirname, '../src/payment/AppPaymentLedger') } })
      worker.on('error', fail)
      worker.on('message', (message) => {
        if (message.ready) {
          ready++
          if (ready === inputs.length) workers.forEach((current) => current.postMessage('run'))
        } else {
          results[index] = message
          completed++
          if (completed === inputs.length) resolveResults(results)
        }
      })
      worker.on('exit', (code) => { if (code) fail(new Error(`ledger worker exited ${code}`)) })
      return worker
    })
  })
}

test('independent SQLite connections race duplicate create and grant without double delivery', async (t) => {
  const filename = join(directory(t), 'concurrent.sqlite'), f = fixture(t, filename)
  const inputs = [1, 2].map(() => ({ kind: 'create', args: [f.user.userId, 'same-request', config, start] }))
  const created = await concurrentOperations(filename, inputs)
  assert.equal(created[0].error, undefined)
  assert.deepEqual(created[0], created[1])
  const order = f.ledger.require(created[0].value)
  const results = await concurrentOperations(filename, [1, 2].map(() => ({ kind: 'grant', args: [order.out_trade_no, verified(order), start] })))
  assert.deepEqual(results.map((result) => result.value).sort(), [false, true])
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, start + 30 * DAY_MS)
  f.ledger.markFinished(order.out_trade_no, start)
  const distinct = await concurrentOperations(filename, ['one', 'two'].map((request) => ({ kind: 'create', args: [f.user.userId, request, config, start] })))
  assert.equal(distinct.filter((result) => result.value).length, 1)
  assert.equal(distinct.filter((result) => result.error === 'VIP_ORDER_PENDING').length, 1)
})

test('pre-migration and post-grant backups restore safely; repeated initialization preserves the old ledger and retries', async (t) => {
  const dir = directory(t), filename = join(dir, 'live.sqlite')
  const oldBackup = join(dir, 'before.sqlite'), newBackup = join(dir, 'after.sqlite')
  let db = new Database(filename)
  db.exec(`CREATE TABLE users (user_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, avatar TEXT NOT NULL,
    last_normal_avatar TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    vip_expires_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES ('legacy','旧用户','/assets/avatars/avatar-1.svg','/assets/avatars/avatar-1.svg',1,1,0);`)
  const old = new PaymentLedger(db)
  const wxOrder = old.create('legacy', 'wechat-request', 'openid', { appId: 'wx-app', offerId: 'offer', productId: 'vip_month', priceFen: 1000, durationDays: 30 }, start)
  old.grant(wxOrder.out_trade_no, start)
  const originalWechat = db.prepare('SELECT * FROM vip_orders').all()
  await db.backup(oldBackup)
  const ledger = new AppPaymentLedger(db)
  const order = ledger.create('legacy', 'app-request', config, start)
  ledger.grantVerified(order.out_trade_no, verified(order, { amountMicros: '99999999999999999999' }), start)
  ledger.markChecked(order.out_trade_no, start, start + 300000, 'PLATFORM_CONFIRM_FAILED')
  await db.backup(newBackup)
  db.close()

  for (const path of [filename, newBackup]) {
    db = new Database(path)
    const reopened = new AppPaymentLedger(db)
    new AppPaymentLedger(db)
    assert.deepEqual(db.prepare('SELECT * FROM vip_orders').all(), originalWechat)
    assert.equal(reopened.create('legacy', 'app-request', config, start).out_trade_no, order.out_trade_no)
    assert.equal(reopened.grantVerified(order.out_trade_no, verified(order, { amountMicros: '99999999999999999999' }), start + DAY_MS), false)
    assert.equal(reopened.require(order.out_trade_no).amount_micros, '99999999999999999999')
    assert.equal(reopened.due.all(start + 300000, start, 100)[0].last_error, 'PLATFORM_CONFIRM_FAILED')
    assert.equal(db.prepare('SELECT vip_expires_at FROM users WHERE user_id = ?').get('legacy').vip_expires_at, start + 60 * DAY_MS)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    db.close()
  }
  db = new Database(oldBackup)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_vip_orders'").get(), undefined)
  new AppPaymentLedger(db)
  assert.deepEqual(db.prepare('SELECT * FROM vip_orders').all(), originalWechat)
  assert.equal(db.prepare('SELECT count(*) AS n FROM app_vip_orders').get().n, 0)
  assert.equal(db.prepare('SELECT vip_expires_at FROM users').get().vip_expires_at, start + 30 * DAY_MS)
  db.close()
})

test('detached financial records retain transaction deduplication but cannot grant to a recreated account', (t) => {
  const f = fixture(t), order = f.grant(f.create())
  assert.equal(f.ledger.detachUserOrders(f.user.userId, start + DAY_MS), 1)
  const detached = f.ledger.require(order.out_trade_no)
  assert.equal(detached.user_id, null)
  assert.equal(detached.account_token, null)
  assert.equal(detached.deleted_at, start + DAY_MS)
  assert.equal(f.ledger.byAccountToken.get('ios', 'sandbox', order.account_token), undefined)
  assert.throws(() => f.ledger.grantVerified(order.out_trade_no, verified(order), start), { code: 'APP_ACCOUNT_DELETED' })
  const recreated = f.store.findOrCreate({ provider: 'apple', scope: 'app.test', subject: 'new-account' })
  const replacement = f.ledger.create(recreated.userId, 'new-request', config, start)
  assert.throws(() => f.ledger.grantVerified(replacement.out_trade_no,
    verified(replacement, { transactionId: verified(order).transactionId }), start), { code: 'PAYMENT_TRANSACTION_CLAIMED' })
  assert.equal(f.ledger.refundVerified(order.out_trade_no, refund(order, 'after-deletion'), start + 2 * DAY_MS), true)
  assert.equal(f.ledger.require(order.out_trade_no).status, 'refunded')
  assert.equal(f.store.getUser(recreated.userId).vipExpiresAt, 0)
})

test('current schema initialization is repeatable and preserves live order data before detachment', (t) => {
  const f = fixture(t), order = f.create()
  new AppPaymentLedger(f.store.db)
  const reopened = new AppPaymentLedger(f.store.db)
  assert.equal(f.store.db.pragma('table_info(app_vip_orders)').filter((column) => column.name === 'account_token_hash').length, 1)
  assert.deepEqual(reopened.require(order.out_trade_no), order)
  assert.equal(reopened.detachUserOrders(f.user.userId, start), 1)
  assert.equal(reopened.detachUserOrders(f.user.userId, start), 0)
  const retained = reopened.findDeletedByAccountToken(order.platform, order.environment, order.account_token)
  assert.equal(retained.out_trade_no, order.out_trade_no)
  assert.equal(retained.user_id, null)
  assert.equal(retained.account_token, null)
  assert.match(retained.account_token_hash, /^[a-f0-9]{64}$/)
  assert.equal(retained.account_token_hash.includes(order.account_token), false)
  assert.equal(f.store.db.pragma('integrity_check', { simple: true }), 'ok')
  assert.deepEqual(f.store.db.pragma('foreign_key_check'), [])
})

test('deleted financial recording requires the fingerprint and explicit permission even with matching locators', (t) => {
  const f = fixture(t), order = f.create(), payment = verified(order)
  f.ledger.detachUserOrders(f.user.userId, start)
  assert.throws(() => f.ledger.recordVerified(order.out_trade_no, payment), { code: 'APP_ACCOUNT_DELETED' })
  assert.throws(() => f.ledger.recordVerified(order.out_trade_no,
    { ...payment, accountToken: 'other-account-token' }, { allowDeleted: true }), { code: 'PAYMENT_IDENTITY_MISMATCH' })
  f.ledger.recordVerified(order.out_trade_no, payment, { allowDeleted: true })
  assert.throws(() => f.ledger.grantVerified(order.out_trade_no, payment, start), { code: 'APP_ACCOUNT_DELETED' })
  f.ledger.recordVerified(order.out_trade_no, { ...payment, status: 'pending' }, { allowDeleted: true })
  assert.equal(f.ledger.require(order.out_trade_no).platform_status, 'purchased')
  assert.equal(f.store.getUser(f.user.userId).vipExpiresAt, 0)
  assert.throws(() => f.ledger.recordVerified(order.out_trade_no,
    { ...payment, accountToken: 'other-account-token' }, { allowDeleted: true }), { code: 'PAYMENT_IDENTITY_MISMATCH' })
  // An invalid retained row cannot substitute a matching transaction for account ownership.
  f.store.db.prepare('UPDATE app_vip_orders SET account_token_hash = NULL WHERE out_trade_no = ?').run(order.out_trade_no)
  assert.equal(f.ledger.findDeletedByAccountToken(order.platform, order.environment, order.account_token), undefined)
  assert.throws(() => f.ledger.recordVerified(order.out_trade_no, payment, { allowDeleted: true }), { code: 'PAYMENT_IDENTITY_MISMATCH' })
  assert.throws(() => f.ledger.recordVerified(order.out_trade_no,
    { ...payment, transactionId: 'different-transaction' }, { allowDeleted: true }), { code: 'PAYMENT_IDENTITY_MISMATCH' })
  assert.equal(f.ledger.require(order.out_trade_no).granted_at, null)
})

test('detachment rolls back when a live order has no account token instead of reusing a stored hash', (t) => {
  const f = fixture(t)
  const first = f.grant(f.create())
  f.create('next')
  f.store.db.prepare('UPDATE app_vip_orders SET account_token = NULL, account_token_hash = ? WHERE out_trade_no = ?')
    .run('a'.repeat(64), first.out_trade_no)
  const before = f.ledger.byUser.all(f.user.userId)
  assert.throws(() => f.ledger.detachUserOrders(f.user.userId, start), { code: 'PAYMENT_IDENTITY_MISMATCH' })
  assert.deepEqual(f.ledger.byUser.all(f.user.userId), before)
})
