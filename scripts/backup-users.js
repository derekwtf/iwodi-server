// 对运行中的 SQLite 使用在线备份 API，备份后检查完整性与身份外键。
require('dotenv').config({ quiet: true })
const Database = require('better-sqlite3')
const { existsSync } = require('fs')
const { resolve } = require('path')

async function main() {
  const source = process.env.USER_DB_PATH
  const destination = process.argv[2]
  if (!source || !destination || resolve(source) === resolve(destination) || existsSync(destination)) {
    throw new Error('用法：USER_DB_PATH=/绝对路径/users.sqlite node scripts/backup-users.js /新备份路径.sqlite（不可覆盖已有文件）')
  }
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try { await db.backup(destination) } finally { db.close() }
  const backup = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok' || backup.pragma('foreign_key_check').length) {
      throw new Error('备份完整性检查未通过')
    }
    console.log('用户库在线备份及完整性检查通过')
  } finally { backup.close() }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
