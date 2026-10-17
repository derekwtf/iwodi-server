function validateDatabase(db) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) {
    throw new Error('快照完整性或外键检查失败')
  }
}

function compactSnapshot(db) {
  validateDatabase(db)
  // A published backup must not depend on WAL/SHM files beside the private copy.
  if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
    throw new Error('快照无法转换为独立数据库文件')
  }
  // Rebuild only the copy so published backups contain no deleted-page residue.
  // SIGKILL/power loss before this finishes may leave raw pages in private staging;
  // abandoned copies are handled by operators as described in the deployment runbooks.
  db.exec('VACUUM')
  validateDatabase(db)
}

module.exports = { compactSnapshot }
