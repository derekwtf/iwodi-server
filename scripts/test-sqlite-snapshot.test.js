const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const Database = require('better-sqlite3')
const UserStore = require('../src/user/UserStore')
const { DELETED_APP_RETENTION_MS } = require('../src/user/app-retention')

const script = join(__dirname, 'backup-users.js')
const start = Date.UTC(2026, 9, 15)
const appProduct = { platform: 'android', environment: 'sandbox', appId: 'test.app',
  storeProductId: 'vip_month', productId: 'vip_month', durationDays: 30 }

function fixture(t) {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'iwodi-snapshot-'))
  const source = join(directory, 'source.sqlite'), destination = join(directory, 'snapshot.sqlite')
  const store = new UserStore(source)
  store.db.pragma('wal_autocheckpoint = 0')
  const user = store.findOrCreate({ provider: 'wechat_mini_program', scope: 'snapshot-test', subject: 'wechat-identity' })
  t.after(() => { if (store.db.open) store.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { directory, source, destination, store, user }
}

function cli(f, { channel = 'wechat', hook = '' } = {}) {
  const env = { ...process.env, USER_DB_PATH: f.source, APP_CHANNEL: channel,
    SNAPSHOT_TEST_DESTINATION: f.destination }
  if (channel === null) delete env.APP_CHANNEL
  const args = []
  if (hook) {
    const preload = join(f.directory, 'preload.cjs')
    fs.writeFileSync(preload, `const assert = require('node:assert/strict')\nconst fs = require('node:fs')\n` +
      `const { dirname } = require('node:path')\nconst Database = require(${JSON.stringify(require.resolve('better-sqlite3'))})\n` +
      `const destination = process.env.SNAPSHOT_TEST_DESTINATION\n${hook}\n`)
    args.push('--require', preload)
  }
  return spawnSync(process.execPath, [...args, script, f.destination], {
    cwd: f.directory, env, encoding: 'utf8', timeout: 10000,
  })
}

const tables = ['users', 'user_identities', 'vip_orders', 'vip_refunds', 'app_vip_orders',
  'app_vip_refunds', 'app_deleted_identities', 'app_deleted_accounts']
const rows = (db) => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const directoryEntries = (f) => fs.readdirSync(f.directory).filter((name) => name !== 'preload.cjs').sort()

for (const channel of [null, 'wechat']) {
  test(`single-file snapshot clears the last purged App identity and transaction with ${channel === null ? 'missing' : 'mistaken'} channel`, (t) => {
    const f = fixture(t), identityMarker = 'purged-last-app-identity-', transactionMarker = 'purged-last-app-transaction-'
    f.store.db.pragma('secure_delete = OFF')
    f.store.updateProfile(f.user.userId, { nickname: '微信备份资料', avatar: '/assets/avatars/avatar-2.svg' })
    const createOrder = (request) => f.store.payments.create(f.user.userId, request, 'wechat-identity', {
      appId: 'test.wechat', offerId: 'offer', productId: 'vip_month', priceFen: 1000, durationDays: 30,
    }, start)
    const first = createOrder('first'), removed = createOrder('removed'), last = createOrder('last')
    f.store.db.prepare('DELETE FROM vip_orders WHERE out_trade_no = ?').run(removed.out_trade_no)
    f.store.payments.grant(first.out_trade_no, start)
    f.store.payments.refund({ id: 'wechat-refund', orderId: first.out_trade_no, amount: 1000,
      result: 0, source: 'query', completedAt: start + 1, now: start + 1 })
    const appUser = f.store.findOrCreate({ provider: 'google', scope: 'snapshot-test', subject: identityMarker.repeat(300) })
    const appOrder = f.store.appPayments.create(appUser.userId, 'last-app-order', appProduct, start - DELETED_APP_RETENTION_MS)
    f.store.appPayments.recordVerified(appOrder.out_trade_no, { ...appProduct, accountToken: appOrder.account_token,
      transactionId: transactionMarker.repeat(300), status: 'pending', quantity: 1 })
    f.store.deleteAppUser(appUser.userId, { now: start - DELETED_APP_RETENTION_MS })
    assert.deepEqual(f.store.purgeDeletedAppData(start), { refunds: 0, orders: 1, identities: 1, accounts: 1 })
    f.store.db.pragma('wal_checkpoint(TRUNCATE)')
    const sourceBefore = fs.readFileSync(f.source), rowsBefore = rows(f.store.db)
    for (const marker of [identityMarker, transactionMarker]) {
      assert.ok(sourceBefore.includes(Buffer.from(marker)), `fixture must contain deleted bytes: ${marker}`)
    }
    const result = cli(f, { channel })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(f.source), sourceBefore, 'compaction must not change source bytes')
    assert.deepEqual(rows(f.store.db), rowsBefore)
    const snapshot = fs.readFileSync(f.destination)
    for (const marker of [identityMarker, transactionMarker]) {
      assert.equal(snapshot.includes(Buffer.from(marker)), false, `published snapshot contains deleted bytes: ${marker}`)
    }
    const copy = new Database(f.destination, { readonly: true, fileMustExist: true })
    try {
      assert.deepEqual(rows(copy), rowsBefore, 'profiles, identities, ledger and refunds must retain their contents')
      assert.deepEqual(copy.prepare('SELECT out_trade_no FROM vip_orders ORDER BY created_at DESC, rowid DESC').all()
        .map((order) => order.out_trade_no), [last.out_trade_no, first.out_trade_no])
      assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok')
      assert.deepEqual(copy.pragma('foreign_key_check'), [])
      assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete')
    } finally { copy.close() }
    assert.deepEqual(directoryEntries(f), ['snapshot.sqlite', 'source.sqlite', 'source.sqlite-shm', 'source.sqlite-wal'])
  })
}

test('single-file compaction failure leaves no published or private snapshot and preserves the source', (t) => {
  const f = fixture(t), before = rows(f.store.db), entries = directoryEntries(f)
  const result = cli(f, { hook: `
    const exec = Database.prototype.exec
    Database.prototype.exec = function (sql) {
      if (/^\\s*VACUUM\\b/i.test(sql)) {
        assert.equal(fs.existsSync(destination), false, 'snapshot cannot be published before compaction')
        assert.equal(dirname(dirname(this.name)), dirname(destination))
        assert.equal(fs.statSync(dirname(this.name)).mode & 0o777, 0o700)
        assert.equal(fs.statSync(this.name).mode & 0o777, 0o600)
        throw new Error('injected snapshot compaction failure')
      }
      return exec.call(this, sql)
    }
  ` })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /injected snapshot compaction failure/)
  assert.equal(fs.existsSync(f.destination), false)
  assert.deepEqual(directoryEntries(f), entries)
  assert.deepEqual(rows(f.store.db), before)
})

test('single-file integrity failure cleans its private copy without publishing or repairing the source', (t) => {
  const f = fixture(t)
  f.store.db.pragma('foreign_keys = OFF')
  f.store.db.prepare('INSERT INTO user_identities VALUES (?,?,?,?,?,?)').run('missing-user', 'wechat_mini_program', 'test', 'orphan', start, start)
  const entries = directoryEntries(f)
  const result = cli(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /完整性|外键/)
  assert.equal(fs.existsSync(f.destination), false)
  assert.deepEqual(directoryEntries(f), entries)
  assert.equal(f.store.db.pragma('foreign_key_check').length, 1)
})

test('single-file publication never replaces an existing destination or one created during copying', (t) => {
  const existing = fixture(t)
  fs.writeFileSync(existing.destination, 'existing target remains intact')
  assert.notEqual(cli(existing).status, 0)
  assert.equal(fs.readFileSync(existing.destination, 'utf8'), 'existing target remains intact')
  const f = fixture(t), entries = directoryEntries(f)
  const result = cli(f, { hook: `
    const backup = Database.prototype.backup
    Database.prototype.backup = function (...args) {
      const contender = new Database(destination)
      contender.exec("CREATE TABLE competitor(value TEXT); INSERT INTO competitor VALUES ('preserve concurrent destination')")
      contender.close()
      return backup.apply(this, args)
    }
  ` })
  assert.notEqual(result.status, 0, 'a destination created after initial validation must block publication')
  const contender = new Database(f.destination, { readonly: true, fileMustExist: true })
  try { assert.equal(contender.prepare('SELECT value FROM competitor').get().value, 'preserve concurrent destination') }
  finally { contender.close() }
  assert.deepEqual(directoryEntries(f), [...entries, 'snapshot.sqlite'].sort())
})

test('single-file publication uses the closed compacted copy and exclusively rejects a destination racing at publication', (t) => {
  const f = fixture(t), entries = directoryEntries(f)
  const result = cli(f, { hook: `
    let compacted
    const exec = Database.prototype.exec
    Database.prototype.exec = function (sql) {
      if (/^\\s*VACUUM\\b/i.test(sql)) compacted = this
      return exec.call(this, sql)
    }
    const link = fs.linkSync
    fs.linkSync = function (source, target) {
      assert.equal(target, destination)
      assert.ok(compacted, 'only a compacted snapshot may be published')
      assert.equal(compacted.name, source)
      assert.equal(compacted.open, false, 'the copy must be closed before publication')
      fs.writeFileSync(destination, 'preserve target created at publication', { flag: 'wx' })
      return link.apply(this, arguments)
    }
  ` })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EEXIST/)
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'preserve target created at publication')
  assert.deepEqual(directoryEntries(f), [...entries, 'snapshot.sqlite'].sort())
})

test('single-file App classification and online copy share a pinned read transaction', (t) => {
  const f = fixture(t), before = rows(f.store.db)
  const result = cli(f, { hook: `
    const backup = Database.prototype.backup
    Database.prototype.backup = function (...args) {
      assert.equal(this.inTransaction, true)
      const UserStore = require(${JSON.stringify(require.resolve('../src/user/UserStore'))})
      const writer = new UserStore(process.env.USER_DB_PATH)
      try { writer.findOrCreate({ provider: 'google', scope: 'race', subject: 'new-live-app-identity' }) }
      finally { writer.close() }
      return backup.apply(this, args)
    }
  ` })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(f.store.db.prepare("SELECT 1 FROM user_identities WHERE provider = 'google'").get())
  const copy = new Database(f.destination, { readonly: true, fileMustExist: true })
  try { assert.deepEqual(rows(copy), before, 'new App data must not enter the classified WeChat snapshot') }
  finally { copy.close() }
})
