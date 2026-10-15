const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { Worker } = require('node:worker_threads')
const UserStore = require('../src/user/UserStore')
const { DELETED_APP_RETENTION_DAYS, DELETED_APP_RETENTION_MS } = require('../src/user/app-retention')

function fixture(t, filename = ':memory:') {
  const store = new UserStore(filename)
  t.after(() => { if (store.db.open) store.close() })
  return store
}
function account(store, subject, now) {
  const user = store.findOrCreate({ provider: 'google', scope: 'retention-test', subject })
  const order = store.appPayments.create(user.userId, 'retention-request-0001', { platform: 'android',
    environment: 'sandbox', appId: 'test.package', storeProductId: 'vip_month', productId: 'vip_month', durationDays: 30 }, now)
  const info = { platform: 'android', environment: 'sandbox', appId: 'test.package', storeProductId: 'vip_month',
    accountToken: order.account_token, transactionId: `transaction-${order.out_trade_no}`, purchaseToken: `purchase-${order.out_trade_no}`,
    status: 'purchased', quantity: 1, purchasedAt: now, currency: 'USD', amountMicros: '1990000' }
  store.appPayments.grantVerified(order.out_trade_no, info, now)
  store.appPayments.refundVerified(order.out_trade_no, { ...info, status: 'refunded', refundId: `refund-${order.out_trade_no}` }, now)
  return { user, order }
}
const empty = { refunds: 0, orders: 0, identities: 0, accounts: 0 }

test('deleted App finance and fingerprints purge exactly at seven days while active and newer data remain', (t) => {
  const store = fixture(t), deletedAt = Date.now()
  assert.equal(DELETED_APP_RETENTION_DAYS, 7)
  const expired = account(store, 'expired', deletedAt - DELETED_APP_RETENTION_MS)
  const recent = account(store, 'recent', deletedAt - DELETED_APP_RETENTION_MS)
  const active = account(store, 'active', deletedAt - 30 * DELETED_APP_RETENTION_MS)
  const wechat = store.findOrCreate({ provider: 'wechat_mini_program', scope: 'mini', subject: 'untouched' })
  store.deleteAppUser(expired.user.userId, { now: deletedAt })
  store.deleteAppUser(recent.user.userId, { now: deletedAt + 1 })
  assert.deepEqual(store.purgeDeletedAppData(deletedAt + DELETED_APP_RETENTION_MS - 1), empty)
  assert.deepEqual(store.purgeDeletedAppData(deletedAt + DELETED_APP_RETENTION_MS), { refunds: 1, orders: 1, identities: 1, accounts: 1 })
  assert.equal(store.appPayments.byId.get(expired.order.out_trade_no), undefined)
  assert.equal(store.appPayments.refundById.get('android', 'sandbox', `refund-${expired.order.out_trade_no}`), undefined)
  assert.equal(store.appPayments.findDeletedByAccountToken('android', 'sandbox', expired.order.account_token), undefined)
  assert.equal(store.isAppUserDeleted(expired.user.userId), false)
  assert.ok(store.isAppUserDeleted(recent.user.userId))
  assert.ok(store.appPayments.byId.get(recent.order.out_trade_no))
  assert.ok(store.appPayments.byId.get(active.order.out_trade_no))
  assert.ok(store.appPayments.refundById.get('android', 'sandbox', `refund-${active.order.out_trade_no}`))
  assert.ok(store.getUser(active.user.userId))
  assert.ok(store.getUser(wechat.userId))
  assert.deepEqual(store.purgeDeletedAppData(deletedAt + DELETED_APP_RETENTION_MS), empty)
  assert.deepEqual(store.db.pragma('foreign_key_check'), [])
})

test('purge rollback restores refunds, orders and both deletion markers together', (t) => {
  const store = fixture(t), now = Date.now()
  const old = account(store, 'rollback', now)
  store.deleteAppUser(old.user.userId, { now })
  store.db.exec("CREATE TRIGGER block_retention BEFORE DELETE ON app_deleted_accounts BEGIN SELECT RAISE(ABORT, 'purge failure'); END")
  assert.throws(() => store.purgeDeletedAppData(now + DELETED_APP_RETENTION_MS), { code: 'USER_STORE_UNAVAILABLE' })
  assert.ok(store.appPayments.byId.get(old.order.out_trade_no))
  assert.ok(store.appPayments.refundById.get('android', 'sandbox', `refund-${old.order.out_trade_no}`))
  assert.ok(store.isAppUserDeleted(old.user.userId))
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM app_deleted_identities').get().n, 1)
  store.db.exec('DROP TRIGGER block_retention')
  assert.deepEqual(store.purgeDeletedAppData(now + DELETED_APP_RETENTION_MS), { refunds: 1, orders: 1, identities: 1, accounts: 1 })
})

function concurrent(filename, kind, userId, now) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const UserStore = require(workerData.modulePath)
      const store = new UserStore(workerData.filename)
      try {
        parentPort.postMessage(workerData.kind === 'purge' ? store.purgeDeletedAppData(workerData.now)
          : store.deleteAppUser(workerData.userId, { now: workerData.now }))
      } finally { store.close() }
    `, { eval: true, workerData: { modulePath: require.resolve('../src/user/UserStore'), filename, kind, userId, now } })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => { if (code) reject(new Error(`retention worker exited ${code}`)) })
  })
}

test('concurrent deletion and purge serialize without removing the new deletion records', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iwodi-retention-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'users.sqlite'), store = fixture(t, filename), now = Date.now()
  const old = account(store, 'old', now), current = account(store, 'current', now)
  store.deleteAppUser(old.user.userId, { now: now - DELETED_APP_RETENTION_MS })
  const [purged, deleted] = await Promise.all([
    concurrent(filename, 'purge', null, now), concurrent(filename, 'delete', current.user.userId, now),
  ])
  assert.deepEqual(purged, { refunds: 1, orders: 1, identities: 1, accounts: 1 })
  assert.deepEqual(deleted, { deleted: true })
  assert.equal(store.appPayments.byId.get(old.order.out_trade_no), undefined)
  assert.equal(store.appPayments.byId.get(current.order.out_trade_no).deleted_at, now)
  assert.ok(store.isAppUserDeleted(current.user.userId))
  assert.equal(store.getUser(current.user.userId), null)
  assert.deepEqual(store.db.pragma('foreign_key_check'), [])
})
