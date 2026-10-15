const Database = require('better-sqlite3')
const fs = require('node:fs')
const { resolve, parse, join, isAbsolute, relative, sep } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { DELETED_APP_RETENTION_MS } = require('../src/user/app-retention')

const ROOT_MARKER = '.iwodi-app-backups.json'
const ROOT_FORMAT = { format: 'iwodi-app-backup-directory', version: 1 }
const FORMAT = 'iwodi-app-backup'
const BUNDLE = /^iwodi-app-(\d+)-(\d+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.backup$/
const COMPLETE_FILES = new Set(['manifest.json', 'users.sqlite'])
const STAGING_FILES = new Set([...COMPLETE_FILES, '.manifest-next.json', 'users.sqlite-wal', 'users.sqlite-shm', 'users.sqlite-journal'])

function fail(message) { throw new Error(`App 备份：${message}`) }
function time(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('时间无效')
  return value
}
function noSymlinks(input) {
  if (typeof input !== 'string' || !isAbsolute(input)) fail('路径必须为绝对路径')
  const path = resolve(input), root = parse(path).root
  let current = root
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    if (fs.lstatSync(current).isSymbolicLink()) fail('路径不可经过符号链接')
  }
  return path
}
function owned(path, directory = false) {
  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) || (!directory && stat.nlink !== 1)) {
    fail('受管目录或文件类型、属主、权限不符合要求')
  }
  if (directory && (stat.mode & 0o700) !== 0o700) fail('受管目录须为 0700')
  return stat
}
function json(path) {
  const stat = owned(path)
  if (stat.size > 4096) fail('受管元数据过大')
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) } catch (_) { fail('受管元数据损坏') }
}
function managedRoot(input, initialize = false) {
  const root = noSymlinks(input)
  owned(root, true)
  const marker = join(root, ROOT_MARKER)
  if (!fs.existsSync(marker)) {
    if (!initialize || fs.readdirSync(root).length) fail('目录尚未受管；请使用专用空目录创建 App 备份')
    fs.writeFileSync(marker, `${JSON.stringify(ROOT_FORMAT)}\n`, { flag: 'wx', mode: 0o400 })
  }
  if (JSON.stringify(json(marker)) !== JSON.stringify(ROOT_FORMAT)) fail('目录标识不属于本工具')
  return root
}
function appExpiry(db, startedAt) {
  // All reads and the online backup use the same pinned read transaction.
  if (db.prepare("SELECT 1 FROM user_identities WHERE provider NOT IN ('apple','google') LIMIT 1").get() ||
      db.prepare('SELECT 1 FROM vip_orders LIMIT 1').get()) fail('源库包含微信或其他渠道记录')
  let expiresAt = startedAt + DELETED_APP_RETENTION_MS
  for (const table of ['app_vip_orders', 'app_deleted_identities', 'app_deleted_accounts']) {
    const { earliest } = db.prepare(`SELECT MIN(deleted_at) AS earliest FROM ${table} WHERE deleted_at IS NOT NULL`).get()
    if (earliest !== null) expiresAt = Math.min(expiresAt, time(earliest) + DELETED_APP_RETENTION_MS)
  }
  return time(expiresAt)
}
function validateDatabase(db) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) {
    fail('快照完整性或外键检查失败')
  }
}
async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function writeManifest(directory, manifest, initial = false) {
  const target = join(directory, initial ? 'manifest.json' : '.manifest-next.json')
  fs.writeFileSync(target, `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o400 })
  if (!initial) fs.renameSync(target, join(directory, 'manifest.json'))
}
function entries(directory, staging) {
  owned(directory, true)
  const names = fs.readdirSync(directory)
  for (const name of names) {
    if (!(staging ? STAGING_FILES : COMPLETE_FILES).has(name)) fail('受管包出现未知文件，停止清理')
    owned(join(directory, name))
  }
  return names
}
function remove(directory, staging) {
  // Only known regular files are unlinked. No recursive removal or symlink traversal.
  const names = entries(directory, staging)
  for (const name of names) fs.unlinkSync(join(directory, name))
  fs.rmdirSync(directory)
}

async function createAppBackup({ source, root: input, now = Date.now }) {
  const startedAt = time(now())
  const root = managedRoot(input, true)
  const path = noSymlinks(source)
  if (!fs.lstatSync(path).isFile()) fail('源库必须为普通文件')
  const location = relative(root, path)
  if (!location.startsWith(`..${sep}`) && location !== '..') fail('源库不能放在受管备份目录内')
  const db = new Database(path, { readonly: true, fileMustExist: true })
  let staging
  try {
    db.exec('BEGIN')
    const expiresAt = appExpiry(db, startedAt)
    if (expiresAt <= startedAt) fail('源库含已过保留期数据；请先核查主库清理任务')
    const id = randomUUID(), name = `iwodi-app-${startedAt}-${expiresAt}-${id}.backup`
    staging = join(root, `.${name}.partial`)
    fs.mkdirSync(staging, { mode: 0o700 })
    const manifest = { format: FORMAT, version: 1, id, startedAt, expiresAt, completed: false }
    writeManifest(staging, manifest, true)
    const snapshot = join(staging, 'users.sqlite')
    fs.closeSync(fs.openSync(snapshot, 'wx', 0o600))
    await db.backup(snapshot)
    db.exec('ROLLBACK')
    const copy = new Database(snapshot, { fileMustExist: true })
    try {
      // A self-contained backup must not depend on copied WAL/SHM files.
      if (copy.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') fail('快照无法转换为独立数据库文件')
      validateDatabase(copy)
      if (appExpiry(copy, startedAt) !== expiresAt) fail('快照的保留期限不一致')
    } finally { copy.close() }
    fs.chmodSync(snapshot, 0o400)
    const sha256 = await digest(snapshot)
    writeManifest(staging, { ...manifest, completed: true, sizeBytes: fs.statSync(snapshot).size, sha256 })
    entries(staging, false)
    managedRoot(root)
    const destination = join(root, name)
    if (fs.existsSync(destination)) fail('目标备份已存在，不可覆盖')
    const finishedAt = time(now())
    if (finishedAt < startedAt || finishedAt >= expiresAt) fail('备份完成时已到期或系统时钟回退，未发布')
    fs.renameSync(staging, destination)
    staging = undefined
    return { bundle: destination, startedAt, expiresAt }
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK')
    db.close()
    if (staging && fs.existsSync(staging)) remove(staging, true)
  }
}

function inspect(root, name, now) {
  const staging = name.startsWith('.') && name.endsWith('.partial')
  const match = (staging ? name.slice(1, -8) : name).match(BUNDLE)
  if (!match) fail('受管名称格式异常，停止清理')
  const directory = join(root, name)
  const files = entries(directory, staging)
  if (!files.includes('manifest.json')) fail('受管包缺少元数据，停止清理')
  const manifest = json(join(directory, 'manifest.json'))
  if (manifest.format !== FORMAT || manifest.version !== 1 || manifest.id !== match[3] ||
      String(time(manifest.startedAt)) !== match[1] || typeof manifest.completed !== 'boolean' ||
      String(time(manifest.expiresAt)) !== match[2] || manifest.expiresAt <= manifest.startedAt ||
      manifest.expiresAt > manifest.startedAt + DELETED_APP_RETENTION_MS || manifest.startedAt > now ||
      (!staging && !manifest.completed)) fail('受管元数据范围异常，停止清理')
  if (manifest.completed) {
    if (!files.includes('users.sqlite') || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) fail('受管快照缺少完整校验信息')
    const snapshot = join(directory, 'users.sqlite')
    if ((owned(snapshot).mode & 0o222) || (owned(join(directory, 'manifest.json')).mode & 0o222)) fail('已完成快照和元数据必须只读')
    // Creation already verified the snapshot. Retention authorization comes from the private
    // managed scope and bound deadline, not whether an expired database remains readable.
  }
  return { directory, staging, expiresAt: manifest.expiresAt }
}

async function pruneAppBackups({ root: input, now = Date.now }) {
  const at = time(now()), root = managedRoot(input)
  const candidates = []
  let ignored = 0
  for (const name of fs.readdirSync(root)) {
    if (name === ROOT_MARKER) continue
    if (!name.startsWith('iwodi-app-') && !name.startsWith('.iwodi-app-')) { ignored++; continue }
    candidates.push(inspect(root, name, at))
  }
  // Validate every candidate before deleting anything so scope errors do not cause a partial sweep.
  let deleted = 0
  for (const candidate of candidates) {
    if (candidate.expiresAt <= at) {
      managedRoot(root)
      remove(candidate.directory, candidate.staging)
      deleted++
    }
  }
  return { deleted, kept: candidates.length - deleted, ignored }
}

module.exports = { createAppBackup, pruneAppBackups }
