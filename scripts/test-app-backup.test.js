const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, realpathSync, existsSync, writeFileSync, readFileSync, statSync,
  mkdirSync, readdirSync, chmodSync, cpSync, utimesSync, symlinkSync, renameSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const fs = require('node:fs')
const UserStore = require('../src/user/UserStore')
const { createAppBackup, pruneAppBackups } = require('./app-backup')
const { DELETED_APP_RETENTION_MS } = require('../src/user/app-retention')

const script = join(__dirname, 'backup-users.js')
function fixture(t, provider = 'google') {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'iwodi-backup-'))
  const source = join(directory, 'source.sqlite')
  const store = new UserStore(source)
  store.db.pragma('wal_autocheckpoint = 0')
  const user = store.findOrCreate({ provider, scope: 'backup-test', subject: 'fixture-identity' })
  t.after(() => { if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, source, store, user }
}
function cli(args, source, extra = {}, cwd = join(__dirname, '..')) {
  const env = { ...process.env, USER_DB_PATH: source || '', APP_CHANNEL: 'wechat', ...extra }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  return spawnSync(process.execPath, [script, ...args], {
    cwd, env,
    encoding: 'utf8', timeout: 10000,
  })
}
function backupRoot(f, name = 'app-backups') {
  const root = join(f.directory, name)
  mkdirSync(root, { mode: 0o700 })
  return root
}
const manifest = (bundle) => JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))
const start = Date.UTC(2026, 9, 15)

test('legacy WeChat CLI copies committed WAL data online without modifying the live source', (t) => {
  const f = fixture(t, 'wechat_mini_program')
  f.store.updateProfile(f.user.userId, { nickname: '在线备份资料', avatar: '/assets/avatars/avatar-2.svg' })
  const before = f.store.getUser(f.user.userId)
  assert.ok(statSync(`${f.source}-wal`).size > 0)
  const destination = join(f.directory, 'wechat-backup.sqlite')
  const result = cli([destination], f.source)
  assert.equal(result.status, 0, result.stderr)
  const copy = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    assert.equal(copy.prepare('SELECT nickname FROM users WHERE user_id = ?').get(f.user.userId).nickname, before.nickname)
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(copy.pragma('foreign_key_check'), [])
  } finally { copy.close() }
  assert.deepEqual(f.store.getUser(f.user.userId), before)
})

test('legacy CLI refuses an existing destination, the source path, or a nonexistent source', (t) => {
  const f = fixture(t, 'wechat_mini_program')
  const destination = join(f.directory, 'existing.sqlite')
  writeFileSync(destination, 'keep-existing-file')
  assert.notEqual(cli([destination], f.source).status, 0)
  assert.equal(readFileSync(destination, 'utf8'), 'keep-existing-file')
  assert.notEqual(cli([f.source], f.source).status, 0)
  assert.ok(f.store.getUser(f.user.userId))
  const absentTarget = join(f.directory, 'absent-target.sqlite')
  assert.notEqual(cli([absentTarget], join(f.directory, 'missing.sqlite')).status, 0)
  assert.equal(existsSync(absentTarget), false)
})

test('App CLI creates a private immutable bundle and independent prune works without a live source', (t) => {
  const f = fixture(t), root = backupRoot(f)
  const created = cli(['app-create', root], f.source, { APP_CHANNEL: 'app' })
  assert.equal(created.status, 0, created.stderr)
  const result = JSON.parse(created.stdout), metadata = manifest(result.bundle)
  assert.equal(metadata.expiresAt, metadata.startedAt + DELETED_APP_RETENTION_MS)
  assert.deepEqual(readdirSync(result.bundle).sort(), ['manifest.json', 'users.sqlite'])
  assert.equal(statSync(result.bundle).mode & 0o777, 0o700)
  for (const name of ['manifest.json', 'users.sqlite']) assert.equal(statSync(join(result.bundle, name)).mode & 0o777, 0o400)
  assert.equal(JSON.stringify(metadata).includes(f.user.userId), false)
  assert.equal(JSON.stringify(metadata).includes('fixture-identity'), false)
  const pruned = cli(['app-prune', root], '', { APP_CHANNEL: 'app' })
  assert.equal(pruned.status, 0, pruned.stderr)
  assert.deepEqual(JSON.parse(pruned.stdout), { deleted: 0, kept: 1, ignored: 0 })
  assert.notEqual(cli([join(f.directory, 'unmanaged.sqlite')], f.source, { APP_CHANNEL: 'app' }).status, 0)
  assert.notEqual(cli(['app-create', root], f.source).status, 0, 'App mode must be explicit')
})

test('active-account snapshot expires exactly seven days from backup start and leaves the live account intact', async (t) => {
  const f = fixture(t), root = backupRoot(f), before = f.store.getUser(f.user.userId)
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS - 1 }), { deleted: 0, kept: 1, ignored: 0 })
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), { deleted: 1, kept: 0, ignored: 0 })
  assert.equal(existsSync(created.bundle), false)
  assert.deepEqual(f.store.getUser(f.user.userId), before)
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), { deleted: 0, kept: 0, ignored: 0 })
})

test('a sixth-day deletion snapshot has one day left and copying it never resets expiry', async (t) => {
  const f = fixture(t), root = backupRoot(f), day = DELETED_APP_RETENTION_MS / 7
  f.store.deleteAppUser(f.user.userId, { now: start - 6 * day })
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  assert.equal(created.expiresAt, start + day)
  const copiedRoot = join(f.directory, 'copied-backups')
  cpSync(root, copiedRoot, { recursive: true, preserveTimestamps: false })
  const copiedBundle = join(copiedRoot, created.bundle.split('/').at(-1))
  chmodSync(copiedRoot, 0o700)
  chmodSync(copiedBundle, 0o700)
  utimesSync(copiedBundle, new Date(start + 6 * day), new Date(start + 6 * day))
  for (const name of ['users.sqlite', 'manifest.json']) utimesSync(join(copiedBundle, name), new Date(start + 6 * day), new Date(start + 6 * day))
  assert.deepEqual(await pruneAppBackups({ root: copiedRoot, now: () => start + day }), { deleted: 1, kept: 0, ignored: 0 })
  assert.ok(existsSync(created.bundle), 'a different managed copy is not implicitly traversed')
  assert.ok(f.store.isAppUserDeleted(f.user.userId), 'backup pruning must not alter source retention records')
})

test('backup data and retention deadlines come from one read snapshot while live deletion proceeds', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  const creating = createAppBackup({ source: f.source, root, now: () => start })
  f.store.deleteAppUser(f.user.userId, { now: start + 1 })
  const created = await creating
  const copy = new Database(join(created.bundle, 'users.sqlite'), { readonly: true, fileMustExist: true })
  try {
    assert.ok(copy.prepare('SELECT user_id FROM users WHERE user_id = ?').get(f.user.userId))
    assert.equal(copy.prepare('SELECT count(*) AS n FROM app_deleted_accounts').get().n, 0)
  } finally { copy.close() }
  assert.equal(created.expiresAt, start + DELETED_APP_RETENTION_MS)
  assert.equal(f.store.getUser(f.user.userId), null)
})

test('expired source records and expiry during copying never publish a usable new backup', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  f.store.deleteAppUser(f.user.userId, { now: start - DELETED_APP_RETENTION_MS })
  await assert.rejects(createAppBackup({ source: f.source, root, now: () => start }), /已过保留期/)
  assert.deepEqual(readdirSync(root), ['.iwodi-app-backups.json'])
  const other = fixture(t), otherRoot = backupRoot(other)
  other.store.deleteAppUser(other.user.userId, { now: start - DELETED_APP_RETENTION_MS + 10 })
  let tick = 0
  await assert.rejects(createAppBackup({ source: other.source, root: otherRoot, now: () => start + (tick++ ? 10 : 0) }), /完成时已到期/)
  assert.deepEqual(readdirSync(otherRoot), ['.iwodi-app-backups.json'])
})

test('foreign-key validation failure removes only its temporary bundle and leaves the source unchanged', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  f.store.db.pragma('foreign_keys = OFF')
  f.store.db.prepare('INSERT INTO user_identities VALUES (?,?,?,?,?,?)').run('missing-user', 'google', 'test', 'orphan', start, start)
  await assert.rejects(createAppBackup({ source: f.source, root, now: () => start }), /外键/)
  assert.deepEqual(readdirSync(root), ['.iwodi-app-backups.json'])
  assert.equal(f.store.db.pragma('foreign_key_check').length, 1, 'the tool never repairs or rewrites the live database')
})

test('published snapshots remove old deleted bytes while preserving retained rows and tied order chronology', async (t) => {
  const f = fixture(t), root = backupRoot(f), day = DELETED_APP_RETENTION_MS / 7
  const identityMarker = 'purged-identity-private-marker-', transactionMarker = 'purged-transaction-private-marker-'
  f.store.db.pragma('secure_delete = OFF')
  const createOrder = (user, requestId) => f.store.appPayments.create(user.userId, requestId, {
    platform: 'android', environment: 'sandbox', appId: 'test.app', storeProductId: 'vip_month',
    productId: 'vip_month', durationDays: 30,
  }, start - DELETED_APP_RETENTION_MS)
  const first = createOrder(f.user, 'active-order-first')
  f.store.appPayments.cancelNative(first.out_trade_no, start)
  const expired = f.store.findOrCreate({ provider: 'google', scope: 'backup-test', subject: identityMarker.repeat(300) })
  const expiredOrder = createOrder(expired, 'expired-order')
  f.store.appPayments.recordVerified(expiredOrder.out_trade_no, {
    platform: 'android', environment: 'sandbox', appId: 'test.app', storeProductId: 'vip_month',
    accountToken: expiredOrder.account_token, transactionId: transactionMarker.repeat(300), status: 'pending', quantity: 1,
  })
  f.store.deleteAppUser(expired.userId, { now: start - DELETED_APP_RETENTION_MS })
  const recent = f.store.findOrCreate({ provider: 'apple', scope: 'backup-test', subject: 'recent-deleted-identity' })
  const recentOrder = createOrder(recent, 'retained-order')
  f.store.deleteAppUser(recent.userId, { now: start - 6 * day })
  const second = createOrder(f.user, 'active-order-second')
  f.store.appPayments.cancelNative(second.out_trade_no, start)
  const third = createOrder(f.user, 'active-order-third')
  assert.deepEqual(f.store.purgeDeletedAppData(start), { refunds: 0, orders: 1, identities: 1, accounts: 1 })
  f.store.db.pragma('wal_checkpoint(TRUNCATE)')
  const sourceBytes = readFileSync(f.source)
  for (const marker of [identityMarker, transactionMarker]) {
    assert.ok(sourceBytes.includes(Buffer.from(marker)), `fixture must retain old deleted bytes: ${marker}`)
  }
  const tables = ['users', 'user_identities', 'app_vip_orders', 'app_vip_refunds', 'app_deleted_identities', 'app_deleted_accounts']
  const rowsBefore = tables.map((table) => f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  assert.equal(created.expiresAt, start + day, 'compaction must retain the original earliest deletion deadline')
  const snapshot = join(created.bundle, 'users.sqlite'), snapshotBytes = readFileSync(snapshot)
  for (const marker of [identityMarker, transactionMarker]) {
    assert.equal(snapshotBytes.includes(Buffer.from(marker)), false, `published backup contains deleted bytes: ${marker}`)
  }
  assert.deepEqual(readFileSync(f.source), sourceBytes, 'only the private copy may be compacted')
  const copy = new Database(snapshot, { readonly: true, fileMustExist: true })
  try {
    assert.deepEqual(tables.map((table) => copy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), rowsBefore)
    assert.deepEqual(copy.prepare('SELECT out_trade_no FROM app_vip_orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(f.user.userId).map((order) => order.out_trade_no), [third.out_trade_no, second.out_trade_no, first.out_trade_no])
    assert.equal(copy.prepare('SELECT deleted_at FROM app_vip_orders WHERE out_trade_no = ?').get(recentOrder.out_trade_no).deleted_at,
      start - 6 * day)
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(copy.pragma('foreign_key_check'), [])
  } finally { copy.close() }
  assert.equal(manifest(created.bundle).sizeBytes, snapshotBytes.length)
  assert.equal(manifest(created.bundle).sha256, createHash('sha256').update(snapshotBytes).digest('hex'))
  assert.deepEqual(readdirSync(created.bundle).sort(), ['manifest.json', 'users.sqlite'])
})

test('compaction failure removes its temporary bundle without publishing or changing the source', async (t) => {
  const f = fixture(t), root = backupRoot(f), before = f.store.getUser(f.user.userId)
  const exec = Database.prototype.exec
  t.mock.method(Database.prototype, 'exec', function (sql) {
    if (/^\s*VACUUM\b/i.test(sql)) throw new Error('snapshot compaction failed')
    return exec.call(this, sql)
  })
  await assert.rejects(createAppBackup({ source: f.source, root, now: () => start }), /snapshot compaction failed/)
  assert.deepEqual(readdirSync(root), ['.iwodi-app-backups.json'])
  assert.deepEqual(f.store.getUser(f.user.userId), before)
})

test('prune leaves unknown and WeChat files intact and validates the entire managed scope before deletion', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  const unknown = join(root, 'wechat-backup.sqlite')
  writeFileSync(unknown, 'preserve-wechat', { mode: 0o600 })
  symlinkSync(unknown, join(root, 'unknown-link'))
  const invalid = join(root, 'iwodi-app-unknown.backup')
  mkdirSync(invalid, { mode: 0o700 })
  await assert.rejects(pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), /名称格式异常/)
  assert.ok(existsSync(created.bundle), 'a later scope failure prevents earlier candidate removal')
  rmSync(invalid, { recursive: true })
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), { deleted: 1, kept: 0, ignored: 2 })
  assert.equal(readFileSync(unknown, 'utf8'), 'preserve-wechat')
  assert.ok(existsSync(join(root, 'unknown-link')))
})

test('prune rejects extra files but removes an authorized damaged database at its fixed deadline', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  const extra = join(created.bundle, 'not-owned.txt')
  writeFileSync(extra, 'keep-this', { mode: 0o600 })
  await assert.rejects(pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), /未知文件/)
  assert.equal(readFileSync(extra, 'utf8'), 'keep-this')
  rmSync(extra)
  const path = join(created.bundle, 'users.sqlite')
  chmodSync(path, 0o600)
  writeFileSync(path, 'truncated and no longer a SQLite database')
  chmodSync(path, 0o400)
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + 1 }), { deleted: 0, kept: 1, ignored: 0 },
    'retained snapshots are not reopened or fully read by the periodic sweep')
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), { deleted: 1, kept: 0, ignored: 0 },
    'a changed size or corrupt payload cannot indefinitely extend retained personal data')
  assert.equal(existsSync(created.bundle), false)
})

test('managed root, source and bundle symlinks are never followed; broad directory permissions are rejected', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  const rootLink = join(f.directory, 'root-link'), sourceLink = join(f.directory, 'source-link.sqlite')
  symlinkSync(root, rootLink); symlinkSync(f.source, sourceLink)
  await assert.rejects(pruneAppBackups({ root: rootLink, now: () => start }), /符号链接/)
  await assert.rejects(createAppBackup({ source: sourceLink, root, now: () => start }), /符号链接/)
  chmodSync(root, 0o755)
  await assert.rejects(pruneAppBackups({ root, now: () => start }), /权限/)
  chmodSync(root, 0o700)
  const moved = join(f.directory, 'outside-bundle')
  renameSync(created.bundle, moved); symlinkSync(moved, created.bundle)
  await assert.rejects(pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), /类型/)
  assert.ok(existsSync(join(moved, 'users.sqlite')))
})

test('an unfinished crash bundle retains its recorded deadline and cannot be treated as completed', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  const partial = join(root, `.${created.bundle.split('/').at(-1)}.partial`)
  renameSync(created.bundle, partial)
  const path = join(partial, 'manifest.json'), metadata = manifest(partial)
  chmodSync(path, 0o600)
  writeFileSync(path, JSON.stringify({ ...metadata, completed: false }))
  chmodSync(path, 0o400)
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS - 1 }), { deleted: 0, kept: 1, ignored: 0 })
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), { deleted: 1, kept: 0, ignored: 0 })
})

test('prune retries failures at each removal step for completed and unfinished bundles', async (t) => {
  for (const staging of [false, true]) {
    for (const step of ['users.sqlite', 'manifest.json', 'directory']) {
      await t.test(`${staging ? 'unfinished' : 'completed'}: ${step}`, async (t) => {
        const f = fixture(t), root = backupRoot(f), at = start + DELETED_APP_RETENTION_MS + 1
        const created = await createAppBackup({ source: f.source, root, now: () => start })
        let bundle = created.bundle
        if (staging) {
          bundle = join(root, `.${bundle.split('/').at(-1)}.partial`)
          renameSync(created.bundle, bundle)
          const metadata = manifest(bundle), path = join(bundle, 'manifest.json')
          chmodSync(path, 0o600)
          writeFileSync(path, JSON.stringify({ ...metadata, completed: false }))
          for (const name of ['.manifest-next.json', 'users.sqlite-wal', 'users.sqlite-shm', 'users.sqlite-journal']) {
            writeFileSync(join(bundle, name), 'partial-write', { mode: 0o600 })
          }
        }
        const other = await createAppBackup({ source: f.source, root, now: () => start + 1 })
        const retained = await createAppBackup({ source: f.source, root, now: () => start + 2 })
        const method = step === 'directory' ? 'rmdirSync' : 'unlinkSync'
        const original = fs[method], failedPath = step === 'directory' ? bundle : join(bundle, step)
        const injected = t.mock.method(fs, method, function (path, ...args) {
          if (path === failedPath) throw new Error(`injected removal failure: ${step}`)
          return original.call(this, path, ...args)
        })
        await assert.rejects(pruneAppBackups({ root, now: () => at }), /injected removal failure/)
        injected.mock.restore()
        assert.ok(existsSync(other.bundle), 'failure leaves the other expired bundle available for the retry')
        if (step !== 'directory') {
          assert.ok(existsSync(join(bundle, 'manifest.json')), 'metadata must survive until payload removal succeeds')
        }
        if (step !== 'users.sqlite') {
          assert.deepEqual(readdirSync(bundle), step === 'manifest.json' ? ['manifest.json'] : [],
            'all payload and temporary files must be removed before metadata')
        }
        assert.deepEqual(await pruneAppBackups({ root, now: () => at }), { deleted: 2, kept: 1, ignored: 0 })
        assert.equal(existsSync(bundle), false)
        assert.equal(existsSync(other.bundle), false)
        assert.ok(existsSync(join(retained.bundle, 'users.sqlite')))
      })
    }
  }
})

test('a completed bundle missing its database is removable only at its bound deadline', async (t) => {
  const f = fixture(t), root = backupRoot(f)
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  rmSync(join(created.bundle, 'users.sqlite'))
  await assert.rejects(pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS - 1 }), /完整校验/)
  const path = join(created.bundle, 'manifest.json'), metadata = manifest(created.bundle)
  chmodSync(path, 0o600)
  await assert.rejects(pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), /只读/)
  writeFileSync(path, JSON.stringify({ ...metadata, sha256: 'invalid' }))
  chmodSync(path, 0o400)
  await assert.rejects(pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), /完整校验/)
  chmodSync(path, 0o600)
  writeFileSync(path, JSON.stringify(metadata))
  chmodSync(path, 0o400)
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + DELETED_APP_RETENTION_MS }), { deleted: 1, kept: 0, ignored: 0 })
})

test('empty removal remnants use validated names and deadlines without relaxing scope checks', async (t) => {
  for (const staging of [false, true]) {
    await t.test(staging ? 'unfinished' : 'completed', async (t) => {
      const f = fixture(t), root = backupRoot(f)
      const created = await createAppBackup({ source: f.source, root, now: () => start })
      let bundle = created.bundle
      if (staging) {
        bundle = join(root, `.${bundle.split('/').at(-1)}.partial`)
        renameSync(created.bundle, bundle)
      }
      for (const name of readdirSync(bundle)) rmSync(join(bundle, name))
      const at = start + DELETED_APP_RETENTION_MS
      assert.deepEqual(await pruneAppBackups({ root, now: () => at - 1 }), { deleted: 0, kept: 1, ignored: 0 })
      chmodSync(bundle, 0o755)
      await assert.rejects(pruneAppBackups({ root, now: () => at }), /权限/)
      chmodSync(bundle, 0o700)
      for (const [startedAt, expiresAt] of [[start, at + 1], [start, start], [at + 1, at + 2], ['0' + start, at], [start, '9007199254740992']]) {
        const invalid = bundle.replace(`${start}-${at}`, `${startedAt}-${expiresAt}`)
        renameSync(bundle, invalid)
        await assert.rejects(pruneAppBackups({ root, now: () => at }), /范围|时间/)
        assert.ok(existsSync(invalid))
        renameSync(invalid, bundle)
      }
      writeFileSync(join(bundle, 'users.sqlite'), 'legacy partial cleanup', { mode: 0o400 })
      await assert.rejects(pruneAppBackups({ root, now: () => at }), /缺少元数据/)
      rmSync(join(bundle, 'users.sqlite'))
      writeFileSync(join(bundle, 'unknown.txt'), 'preserve', { mode: 0o600 })
      await assert.rejects(pruneAppBackups({ root, now: () => at }), /未知文件/)
      rmSync(join(bundle, 'unknown.txt'))
      symlinkSync(f.source, join(bundle, 'users.sqlite'))
      await assert.rejects(pruneAppBackups({ root, now: () => at }), /类型/)
      rmSync(join(bundle, 'users.sqlite'))
      assert.deepEqual(await pruneAppBackups({ root, now: () => at }), { deleted: 1, kept: 0, ignored: 0 })
      assert.ok(f.store.getUser(f.user.userId))
    })
  }
})

test('App mode rejects a WeChat source and cannot adopt a nonempty unmarked directory', async (t) => {
  const f = fixture(t, 'wechat_mini_program'), root = backupRoot(f), user = f.store.getUser(f.user.userId)
  await assert.rejects(createAppBackup({ source: f.source, root, now: () => start }), /其他渠道/)
  assert.deepEqual(f.store.getUser(f.user.userId), user)
  const unknownRoot = backupRoot(f, 'unknown-directory')
  writeFileSync(join(unknownRoot, 'existing.sqlite'), 'unchanged')
  await assert.rejects(pruneAppBackups({ root: unknownRoot, now: () => start }), /尚未受管/)
  await assert.rejects(createAppBackup({ source: f.source, root: unknownRoot, now: () => start }), /尚未受管/)
  assert.equal(readFileSync(join(unknownRoot, 'existing.sqlite'), 'utf8'), 'unchanged')
})

test('standalone prune CLI removes expired App bundles while the source is absent', async (t) => {
  const f = fixture(t), root = backupRoot(f), oldStart = Date.now() - DELETED_APP_RETENTION_MS - 1000
  const created = await createAppBackup({ source: f.source, root, now: () => oldStart })
  const result = cli(['app-prune', root], join(f.directory, 'nonexistent-source.sqlite'), { APP_CHANNEL: 'app' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { deleted: 1, kept: 0, ignored: 0 })
  assert.equal(existsSync(created.bundle), false)
  assert.ok(f.store.getUser(f.user.userId))
})

test('manifest expiry cannot be extended independently of the published bundle name', async (t) => {
  const f = fixture(t), root = backupRoot(f), day = DELETED_APP_RETENTION_MS / 7
  f.store.deleteAppUser(f.user.userId, { now: start - 6 * day })
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  const path = join(created.bundle, 'manifest.json')
  chmodSync(path, 0o600)
  writeFileSync(path, JSON.stringify({ ...manifest(created.bundle), expiresAt: start + DELETED_APP_RETENTION_MS }))
  chmodSync(path, 0o400)
  await assert.rejects(pruneAppBackups({ root, now: () => start + day }), /元数据范围异常/)
  assert.ok(existsSync(created.bundle), 'invalid metadata is reported instead of silently trusted or deleted')
})

test('retained financial rows independently bound expiry even when deletion markers are absent', async (t) => {
  const f = fixture(t), root = backupRoot(f), day = DELETED_APP_RETENTION_MS / 7
  const order = f.store.appPayments.create(f.user.userId, 'backup-financial-request', {
    platform: 'android', environment: 'sandbox', appId: 'test.app', storeProductId: 'vip_month', productId: 'vip_month', durationDays: 30,
  }, start - 6 * day)
  f.store.deleteAppUser(f.user.userId, { now: start - 6 * day })
  f.store.db.exec('DELETE FROM app_deleted_identities; DELETE FROM app_deleted_accounts')
  const created = await createAppBackup({ source: f.source, root, now: () => start })
  assert.equal(created.expiresAt, start + day)
  assert.deepEqual(await pruneAppBackups({ root, now: () => start + day }), { deleted: 1, kept: 0, ignored: 0 })
  assert.equal(f.store.appPayments.require(order.out_trade_no).deleted_at, start - 6 * day)
})

test('missing or mistaken APP_CHANNEL cannot export App identities, deletion markers or finance as unmanaged SQLite', (t) => {
  for (const state of ['identity', 'deletion', 'finance']) {
    const f = fixture(t)
    if (state === 'finance') {
      f.store.appPayments.create(f.user.userId, 'unmanaged-backup-request', { platform: 'android', environment: 'sandbox',
        appId: 'test.app', storeProductId: 'vip_month', productId: 'vip_month', durationDays: 30 }, start)
    }
    if (state !== 'identity') f.store.deleteAppUser(f.user.userId, { now: start })
    if (state === 'finance') f.store.db.exec('DELETE FROM app_deleted_identities; DELETE FROM app_deleted_accounts')
    for (const channel of [undefined, 'wechat']) {
      const destination = join(f.directory, `unmanaged-${String(channel)}.sqlite`)
      const result = cli([destination], f.source, { APP_CHANNEL: channel }, f.directory)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /源库包含 App 记录.*app-create/)
      assert.equal(existsSync(destination), false)
    }
  }
})

test('legacy WeChat schema without App tables remains supported by the original command', (t) => {
  const f = fixture(t, 'wechat_mini_program'), source = join(f.directory, 'old-wechat.sqlite')
  const db = new Database(source)
  db.exec("CREATE TABLE users(user_id TEXT PRIMARY KEY); CREATE TABLE user_identities(user_id TEXT REFERENCES users(user_id), provider TEXT); INSERT INTO users VALUES ('wechat-user'); INSERT INTO user_identities VALUES ('wechat-user','wechat_mini_program')")
  db.close()
  const destination = join(f.directory, 'old-wechat-copy.sqlite')
  const result = cli([destination], source)
  assert.equal(result.status, 0, result.stderr)
  const copy = new Database(destination, { readonly: true, fileMustExist: true })
  try { assert.equal(copy.prepare('SELECT provider FROM user_identities').get().provider, 'wechat_mini_program') }
  finally { copy.close() }
})
