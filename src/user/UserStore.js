const Database = require('better-sqlite3')
const { randomUUID } = require('crypto')
const { createDefaultProfile, normalizeProfile } = require('./profile')

function storageError() {
  return Object.assign(new Error('用户服务暂时不可用，请稍后重试'), {
    code: 'USER_STORE_UNAVAILABLE', statusCode: 503,
  })
}

class UserStore {
  constructor(filename) {
    if (!filename) throw new Error('必须配置 USER_DB_PATH')
    this.db = new Database(filename)
    try {
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('journal_mode = WAL')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY NOT NULL,
          nickname TEXT NOT NULL,
          avatar TEXT NOT NULL,
          last_normal_avatar TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_identities (
          user_id TEXT NOT NULL REFERENCES users(user_id),
          provider TEXT NOT NULL CHECK(length(trim(provider)) > 0),
          scope TEXT NOT NULL CHECK(length(trim(scope)) > 0),
          subject TEXT NOT NULL CHECK(length(trim(subject)) > 0),
          created_at INTEGER NOT NULL,
          last_login_at INTEGER NOT NULL,
          UNIQUE(provider, scope, subject)
        );
        CREATE INDEX IF NOT EXISTS user_identities_user_id ON user_identities(user_id);
      `)
      this.read = this.db.prepare('SELECT user_id AS userId, nickname, avatar FROM users WHERE user_id = ?')
      this.find = this.db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND scope = ? AND subject = ?')
      this.insertUser = this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
      this.insertIdentity = this.db.prepare('INSERT INTO user_identities VALUES (?, ?, ?, ?, ?, ?)')
      this.touchLogin = this.db.prepare('UPDATE user_identities SET last_login_at = ? WHERE provider = ? AND scope = ? AND subject = ?')
      this.save = this.db.prepare('UPDATE users SET nickname = ?, avatar = ?, last_normal_avatar = ?, updated_at = ? WHERE user_id = ?')
      this.login = this.db.transaction((provider, scope, subject) => {
        const now = Date.now()
        const existing = this.find.get(provider, scope, subject)
        if (existing) {
          this.touchLogin.run(now, provider, scope, subject)
          return this.read.get(existing.user_id)
        }
        const userId = randomUUID()
        const profile = createDefaultProfile()
        this.insertUser.run(userId, profile.nickname, profile.avatar, profile.avatar, now, now)
        this.insertIdentity.run(userId, provider, scope, subject, now, now)
        return { userId, ...profile }
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  findOrCreate({ provider, scope, subject }) {
    if (![provider, scope, subject].every((value) => typeof value === 'string' && value.trim())) {
      throw Object.assign(new Error('缺少已验证的登录身份'), { code: 'IDENTITY_REQUIRED' })
    }
    try {
      return this.login.immediate(provider, scope, subject)
    } catch (_) {
      throw storageError()
    }
  }

  getUser(userId) {
    try {
      return this.read.get(userId) || null
    } catch (_) {
      throw storageError()
    }
  }

  updateProfile(userId, input) {
    const profile = normalizeProfile(input)
    try {
      const result = this.save.run(profile.nickname, profile.avatar, profile.avatar, Date.now(), userId)
      if (result.changes !== 1) throw storageError()
      return profile
    } catch (_) {
      throw storageError()
    }
  }

  close() { this.db.close() }
}

module.exports = UserStore
