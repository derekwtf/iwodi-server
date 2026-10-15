const Database = require('better-sqlite3')
const PaymentLedger = require('../payment/PaymentLedger')
const AppPaymentLedger = require('../payment/AppPaymentLedger')
const { randomUUID, createHash } = require('crypto')
const { AVATARS, createDefaultProfile, normalizeProfile, resolveStoredProfile } = require('./profile')
const { DELETED_APP_RETENTION_MS, APP_PROOF_CLOCK_SKEW_MS } = require('./app-retention')

function storageError() {
  return Object.assign(new Error('用户服务暂时不可用，请稍后重试'), {
    code: 'USER_STORE_UNAVAILABLE', statusCode: 503,
  })
}

const fingerprint = (purpose, value) => createHash('sha256')
  .update(`iwodi-app-deletion-v1:${purpose}:`).update(JSON.stringify(value)).digest('hex')
const identityFingerprint = ({ provider, scope, subject }) => fingerprint('identity', [provider, scope, subject])
const accountError = (code, message, statusCode = 403) => Object.assign(new Error(message), { code, statusCode })

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
        CREATE TABLE IF NOT EXISTS app_deleted_identities (
          identity_hash TEXT PRIMARY KEY NOT NULL,
          deleted_at INTEGER NOT NULL, proof_cutoff_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_deleted_accounts (
          account_hash TEXT PRIMARY KEY NOT NULL, deleted_at INTEGER NOT NULL
        );
      `)
      if (!this.db.pragma('table_info(users)').some((column) => column.name === 'vip_expires_at')) {
        this.db.exec('ALTER TABLE users ADD COLUMN vip_expires_at INTEGER NOT NULL DEFAULT 0')
      }
      this.payments = new PaymentLedger(this.db)
      this.appPayments = new AppPaymentLedger(this.db)
      this.read = this.db.prepare(`SELECT user_id AS userId, nickname, avatar,
        last_normal_avatar AS lastNormalAvatar, vip_expires_at AS vipExpiresAt FROM users WHERE user_id = ?`)
      this.find = this.db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND scope = ? AND subject = ?')
      this.insertUser = this.db.prepare(`INSERT INTO users
        (user_id, nickname, avatar, last_normal_avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      this.insertIdentity = this.db.prepare('INSERT INTO user_identities VALUES (?, ?, ?, ?, ?, ?)')
      this.touchLogin = this.db.prepare('UPDATE user_identities SET last_login_at = ? WHERE provider = ? AND scope = ? AND subject = ?')
      this.identitiesForUser = this.db.prepare('SELECT provider, scope, subject FROM user_identities WHERE user_id = ?')
      this.deletedIdentity = this.db.prepare('SELECT proof_cutoff_at FROM app_deleted_identities WHERE identity_hash = ?')
      this.deletedAccount = this.db.prepare('SELECT deleted_at FROM app_deleted_accounts WHERE account_hash = ?')
      this.rememberIdentityDeletion = this.db.prepare(`INSERT INTO app_deleted_identities VALUES (?, ?, ?)
        ON CONFLICT(identity_hash) DO UPDATE SET deleted_at = excluded.deleted_at,
        proof_cutoff_at = MAX(app_deleted_identities.proof_cutoff_at, excluded.proof_cutoff_at)`)
      this.rememberAccountDeletion = this.db.prepare('INSERT OR IGNORE INTO app_deleted_accounts VALUES (?, ?)')
      this.removeIdentities = this.db.prepare('DELETE FROM user_identities WHERE user_id = ?')
      this.removeUser = this.db.prepare('DELETE FROM users WHERE user_id = ?')
      this.purgeDeletedIdentities = this.db.prepare('DELETE FROM app_deleted_identities WHERE deleted_at <= ?')
      this.purgeDeletedAccounts = this.db.prepare('DELETE FROM app_deleted_accounts WHERE deleted_at <= ?')
      this.purgeDeletedData = this.db.transaction((cutoff) => {
        const financial = this.appPayments.purgeDeletedBefore(cutoff)
        return { ...financial, identities: this.purgeDeletedIdentities.run(cutoff).changes,
          accounts: this.purgeDeletedAccounts.run(cutoff).changes }
      })
      this.save = this.db.prepare('UPDATE users SET nickname = ?, avatar = ?, last_normal_avatar = ?, updated_at = ? WHERE user_id = ?')
      this.login = this.db.transaction((provider, scope, subject, issuedAt) => {
        const now = Date.now()
        if (provider === 'apple' || provider === 'google') {
          const deleted = this.deletedIdentity.get(identityFingerprint({ provider, scope, subject }))
          if (deleted && (!Number.isSafeInteger(issuedAt) || issuedAt <= deleted.proof_cutoff_at)) {
            throw accountError('APP_REAUTH_REQUIRED', '账号已删除，请稍后重新授权创建新账号', 401)
          }
        }
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
      this.deleteAppAccount = this.db.transaction((userId, expectedIdentity, now) => {
        if (!this.read.get(userId)) {
          if (this.deletedAccount.get(fingerprint('account', userId))) return { deleted: true }
          throw accountError('AUTH_INVALID', '登录已失效，请重新登录', 401)
        }
        const identity = this.getAppIdentity(userId)
        if (expectedIdentity && ['provider', 'scope', 'subject'].some((key) => identity[key] !== expectedIdentity[key])) {
          throw accountError('APP_IDENTITY_CHANGED', '账号身份已变化，请重新确认')
        }
        // App deletion never rewrites or detaches the independent WeChat financial history.
        if (this.payments.latest.get(userId)) throw accountError('APP_ACCOUNT_REQUIRED', '此账号存在非 App 记录，请通过支持渠道处理')
        this.appPayments.detachUserOrders(userId, now)
        this.rememberIdentityDeletion.run(identityFingerprint(identity), now, now + APP_PROOF_CLOCK_SKEW_MS)
        this.rememberAccountDeletion.run(fingerprint('account', userId), now)
        this.removeIdentities.run(userId)
        this.removeUser.run(userId)
        return { deleted: true }
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  findOrCreate({ provider, scope, subject, issuedAt }) {
    if (![provider, scope, subject].every((value) => typeof value === 'string' && value.trim())) {
      throw Object.assign(new Error('缺少已验证的登录身份'), { code: 'IDENTITY_REQUIRED' })
    }
    try {
      return this.login.immediate(provider, scope, subject, issuedAt)
    } catch (error) {
      if (error.code === 'APP_REAUTH_REQUIRED') throw error
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

  getAppIdentity(userId) {
    try {
      const identities = this.identitiesForUser.all(userId)
      if (identities.length !== 1 || !['apple', 'google'].includes(identities[0].provider)) {
        throw accountError('APP_ACCOUNT_REQUIRED', '此操作仅支持独立 App 账号')
      }
      return identities[0]
    } catch (error) {
      if (error.code === 'APP_ACCOUNT_REQUIRED') throw error
      throw storageError()
    }
  }

  isAppUserDeleted(userId) {
    try { return Boolean(this.deletedAccount.get(fingerprint('account', userId))) }
    catch (_) { throw storageError() }
  }

  deleteAppUser(userId, { expectedIdentity, now = Date.now() } = {}) {
    try { return this.deleteAppAccount.immediate(userId, expectedIdentity, now) }
    catch (error) {
      if (['AUTH_INVALID', 'APP_ACCOUNT_REQUIRED', 'APP_IDENTITY_CHANGED'].includes(error.code)) throw error
      throw storageError()
    }
  }

  purgeDeletedAppData(now = Date.now()) {
    try {
      if (!Number.isSafeInteger(now) || now < 0) throw storageError()
      return this.purgeDeletedData.immediate(now - DELETED_APP_RETENTION_MS)
    } catch (_) { throw storageError() }
  }

  close() { this.db.close() }
}

module.exports = UserStore
