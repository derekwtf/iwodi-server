// 在线复制运行中的 SQLite，仅整理私有副本，校验后发布。
require('dotenv').config({ quiet: true })
const Database = require('better-sqlite3')
const fs = require('node:fs')
const { resolve, dirname, join } = require('node:path')
const { compactSnapshot } = require('./sqlite-snapshot')

function containsAppRecords(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  if (tables.has('user_identities') &&
      db.prepare("SELECT 1 FROM user_identities WHERE provider IN ('apple','google') LIMIT 1").get()) return true
  return ['app_vip_orders', 'app_vip_refunds', 'app_deleted_identities', 'app_deleted_accounts']
    .some((table) => tables.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
}

async function main() {
  const source = process.env.USER_DB_PATH
  const destination = process.argv[2]
  if (destination === 'app-create' || destination === 'app-prune') {
    const root = process.argv[3]
    if (process.env.APP_CHANNEL !== 'app' || !root || process.argv.length !== 4 ||
        (destination === 'app-create' && !source)) {
      throw new Error('用法：APP_CHANNEL=app USER_DB_PATH=/绝对路径/users.sqlite node scripts/backup-users.js app-create /专用空目录；独立清理使用 app-prune /受管目录')
    }
    const { createAppBackup, pruneAppBackups } = require('./app-backup')
    const result = destination === 'app-create' ? await createAppBackup({ source, root }) : await pruneAppBackups({ root })
    console.log(JSON.stringify(result))
    return
  }
  if (process.env.APP_CHANNEL === 'app') throw new Error('App 备份请使用 app-create 创建带有效期的受管备份包')
  if (!source || !destination || resolve(source) === resolve(destination) || fs.existsSync(destination)) {
    throw new Error('用法：USER_DB_PATH=/绝对路径/users.sqlite node scripts/backup-users.js /新备份路径.sqlite（不可覆盖已有文件）')
  }
  let staging
  try {
    const db = new Database(source, { readonly: true, fileMustExist: true })
    let snapshot
    try {
      // Classification and online copying must observe the same read snapshot.
      db.exec('BEGIN')
      if (containsAppRecords(db)) throw new Error('源库包含 App 记录，请使用 APP_CHANNEL=app 和 app-create 创建带有效期的备份')
      staging = fs.mkdtempSync(join(dirname(resolve(destination)), '.iwodi-snapshot-'))
      snapshot = join(staging, 'users.sqlite')
      fs.closeSync(fs.openSync(snapshot, 'wx', 0o600))
      await db.backup(snapshot)
    } finally {
      try { if (db.inTransaction) db.exec('ROLLBACK') }
      finally { db.close() }
    }
    const backup = new Database(snapshot, { fileMustExist: true })
    try { compactSnapshot(backup) }
    finally { backup.close() }
    // Same-filesystem hard-link creation publishes atomically and refuses any existing target.
    fs.linkSync(snapshot, destination)
  } finally {
    // SIGKILL/power loss bypasses finally. Operators remove abandoned .iwodi-snapshot-*
    // directories after confirming the backup process has exited; see deploy.md section 9.1.
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
  }
  console.log('用户库在线备份及完整性检查通过')
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
