const Database = require('better-sqlite3')
const PaymentLedger = require('../payment/PaymentLedger')
const { randomUUID } = require('crypto')
const { AVATARS, createDefaultProfile, normalizeProfile, resolveStoredProfile } = require('./profile')

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
      if (!this.db.pragma('table_info(users)').some((column) => column.name === 'vip_expires_at')) {
        this.db.exec('ALTER TABLE users ADD COLUMN vip_expires_at INTEGER NOT NULL DEFAULT 0')
      }
      this.payments = new PaymentLedger(this.db)
      this.read = this.db.prepare(`SELECT user_id AS userId, nickname, avatar,
        last_normal_avatar AS lastNormalAvatar, vip_expires_at AS vipExpiresAt FROM users WHERE user_id = ?`)
      this.find = this.db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND scope = ? AND subject = ?')
      this.insertUser = this.db.prepare(`INSERT INTO users
        (user_id, nickname, avatar, last_normal_avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      this.insertIdentity = this.db.prepare('INSERT INTO user_identities VALUES (?, ?, ?, ?, ?, ?)')
      this.touchLogin = this.db.prepare('UPDATE user_identities SET last_login_at = ? WHERE provider = ? AND scope = ? AND subject = ?')
      this.save = this.db.prepare('UPDATE users SET nickname = ?, avatar = ?, last_normal_avatar = ?, updated_at = ? WHERE user_id = ?')
      this.login = this.db.transaction((provider, scope, subject) => {
        const now = Date.now()
        const existing = this.find.get(provider, scope, subject)
        if (existing) {
          this.touchLogin.run(now, provider, scope, subject)
          return this.getUser(existing.user_id)
        }
        const userId = randomUUID()
        const profile = createDefaultProfile()
        this.insertUser.run(userId, profile.nickname, profile.avatar, profile.avatar, now, now)
        this.insertIdentity.run(userId, provider, scope, subject, now, now)
        return this.getUser(userId)
      })
      this.saveProfile = this.db.transaction((userId, input) => {
        const user = this.getUser(userId)
        if (!user) throw storageError()
        const profile = normalizeProfile(input, user.isVip)
        this.save.run(profile.nickname, profile.avatar,
          AVATARS.has(profile.avatar) ? profile.avatar : user.lastNormalAvatar, Date.now(), userId)
        return this.getUser(userId)
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
      const stored = this.read.get(userId)
      const user = resolveStoredProfile(stored)
      if (user && (stored.avatar !== user.avatar || stored.lastNormalAvatar !== user.lastNormalAvatar)) {
        this.save.run(user.nickname, user.avatar, user.lastNormalAvatar, Date.now(), userId)
      }
      return user || null
    } catch (_) {
      throw storageError()
    }
  }

  updateProfile(userId, input) {
    try {
      return this.saveProfile.immediate(userId, input)
    } catch (error) {
      if (error.code === 'INVALID_NICKNAME' || error.code === 'INVALID_AVATAR') throw error
      throw storageError()
    }
  }

  close() { this.db.close() }
}

module.exports = UserStore
