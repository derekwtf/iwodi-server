const { randomBytes, randomUUID, createHash } = require('crypto')
const { DAY_MS, paymentError } = require('./config')

const DURATION_MS = 30 * DAY_MS
const accountTokenHash = (token) => createHash('sha256').update('iwodi-deleted-order-token-v1:').update(token).digest('hex')

function micros(value) {
  if (value == null) return null
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,30})$/.test(value)) throw paymentError('PAYMENT_AMOUNT_MISMATCH')
  return value
}

// Shares UserStore's SQLite connection. Store identity, delivery and entitlement
// changes commit together; the WeChat ledger and its currency rules stay separate.
class AppPaymentLedger {
  constructor(db) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_vip_orders (
        out_trade_no TEXT PRIMARY KEY NOT NULL,
        user_id TEXT REFERENCES users(user_id), request_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('ios','android')),
        environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
        app_id TEXT NOT NULL, store_product_id TEXT NOT NULL,
        product_id TEXT NOT NULL CHECK(product_id = 'vip_month'),
        duration_ms INTEGER NOT NULL CHECK(duration_ms = ${DURATION_MS}),
        account_token TEXT UNIQUE, account_token_hash TEXT,
        transaction_id TEXT, purchase_token TEXT,
        currency TEXT, amount_micros TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','granted','refunded','closed')),
        platform_status TEXT, created_at INTEGER NOT NULL, paid_at INTEGER,
        granted_at INTEGER, starts_at INTEGER, ends_at INTEGER,
        platform_ack_at INTEGER, refunded_at INTEGER, revoked_ms INTEGER NOT NULL DEFAULT 0,
        client_cancelled_at INTEGER, closure_reason TEXT,
        review_reason TEXT, last_error TEXT, last_checked_at INTEGER, next_check_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(user_id, request_id),
        UNIQUE(platform, environment, transaction_id),
        UNIQUE(platform, environment, purchase_token)
      );
      CREATE INDEX IF NOT EXISTS app_vip_orders_due ON app_vip_orders(next_check_at);
      CREATE INDEX IF NOT EXISTS app_vip_orders_user ON app_vip_orders(user_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS app_vip_orders_pending ON app_vip_orders(user_id)
        WHERE status = 'pending' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS app_vip_orders_deleted_token
        ON app_vip_orders(platform, environment, account_token_hash) WHERE account_token_hash IS NOT NULL;
      CREATE TABLE IF NOT EXISTS app_vip_refunds (
        platform TEXT NOT NULL, environment TEXT NOT NULL, refund_id TEXT NOT NULL,
        out_trade_no TEXT NOT NULL REFERENCES app_vip_orders(out_trade_no),
        amount_micros TEXT, currency TEXT,
        result TEXT NOT NULL CHECK(result IN ('pending','failed','completed')),
        source TEXT NOT NULL, completed_at INTEGER, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(platform, environment, refund_id)
      );
    `)
    this.byId = db.prepare('SELECT * FROM app_vip_orders WHERE out_trade_no = ?')
    this.byRequest = db.prepare('SELECT * FROM app_vip_orders WHERE user_id = ? AND request_id = ?')
    this.byAccountToken = db.prepare('SELECT * FROM app_vip_orders WHERE platform = ? AND environment = ? AND account_token = ?')
    this.byDeletedTokenHash = db.prepare(`SELECT * FROM app_vip_orders
      WHERE platform = ? AND environment = ? AND account_token_hash = ? AND deleted_at IS NOT NULL`)
    this.byTransaction = db.prepare('SELECT * FROM app_vip_orders WHERE platform = ? AND environment = ? AND transaction_id = ?')
    this.byPurchaseToken = db.prepare('SELECT * FROM app_vip_orders WHERE platform = ? AND environment = ? AND purchase_token = ?')
    this.latest = db.prepare('SELECT * FROM app_vip_orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    this.byUser = db.prepare('SELECT * FROM app_vip_orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
    this.pendingForUser = db.prepare(`SELECT * FROM app_vip_orders WHERE user_id = ? AND deleted_at IS NULL AND
      (status = 'pending' OR (status = 'granted' AND platform_ack_at IS NULL)) ORDER BY created_at, rowid LIMIT 1`)
    this.due = db.prepare(`SELECT * FROM app_vip_orders WHERE deleted_at IS NULL AND next_check_at <= ? AND
      (status = 'pending' OR (status = 'granted' AND (platform_ack_at IS NULL OR ends_at > ?)))
      ORDER BY next_check_at, out_trade_no LIMIT ?`)
    this.refundById = db.prepare('SELECT * FROM app_vip_refunds WHERE platform = ? AND environment = ? AND refund_id = ?')
    this.insert = db.prepare(`INSERT INTO app_vip_orders
      (out_trade_no,user_id,request_id,platform,environment,app_id,store_product_id,product_id,
       duration_ms,account_token,created_at,next_check_at)
      VALUES (@id,@userId,@requestId,@platform,@environment,@appId,@storeProductId,'vip_month',
        ${DURATION_MS},@accountToken,@now,@now)`)
    this.readExpiry = db.prepare('SELECT vip_expires_at FROM users WHERE user_id = ?')
    this.setExpiry = db.prepare('UPDATE users SET vip_expires_at = ?, updated_at = ? WHERE user_id = ?')
    this.setPlatform = db.prepare(`UPDATE app_vip_orders SET
      transaction_id = COALESCE(transaction_id, @transactionId), purchase_token = COALESCE(purchase_token, @purchaseToken),
      currency = COALESCE(currency, @currency), amount_micros = COALESCE(amount_micros, @amountMicros),
      paid_at = COALESCE(paid_at, @purchasedAt), platform_status = CASE
        WHEN status = 'refunded' THEN 'refunded'
        WHEN platform_status = 'cancelled' AND @status IN ('pending','purchased') THEN platform_status
        WHEN (status = 'granted' OR platform_status = 'purchased') AND @status = 'pending' THEN platform_status
        ELSE @status END WHERE out_trade_no = @id`)
    this.setGrant = db.prepare(`UPDATE app_vip_orders SET status = 'granted', granted_at = ?, starts_at = ?, ends_at = ?,
      closure_reason = NULL WHERE out_trade_no = ?`)
    this.ack = db.prepare(`UPDATE app_vip_orders SET platform_ack_at = COALESCE(platform_ack_at, ?)
      WHERE out_trade_no = ? AND status = 'granted' AND platform_ack_at IS NULL`)
    this.checked = db.prepare('UPDATE app_vip_orders SET last_checked_at = ?, next_check_at = ?, last_error = ? WHERE out_trade_no = ?')
    this.closeOrder = db.prepare(`UPDATE app_vip_orders SET status = 'closed', closure_reason = 'platform_cancelled'
      WHERE out_trade_no = ? AND status IN ('pending','closed')`)
    this.nativeCancellation = db.prepare(`UPDATE app_vip_orders SET status = 'closed', client_cancelled_at = ?, closure_reason = ?
      WHERE out_trade_no = ? AND status = 'pending' AND transaction_id IS NULL AND purchase_token IS NULL`)
    this.review = db.prepare('UPDATE app_vip_orders SET review_reason = ? WHERE out_trade_no = ?')
    this.putRefund = db.prepare(`INSERT INTO app_vip_refunds VALUES
      (@platform,@environment,@refundId,@id,@amountMicros,@currency,@result,@source,@completedAt,@now)
      ON CONFLICT(platform,environment,refund_id) DO UPDATE SET
        result = excluded.result, completed_at = excluded.completed_at,
        amount_micros = COALESCE(app_vip_refunds.amount_micros, excluded.amount_micros),
        currency = COALESCE(app_vip_refunds.currency, excluded.currency)
      WHERE app_vip_refunds.result != 'completed'`)
    this.revoke = db.prepare(`UPDATE app_vip_orders SET status = 'refunded', refunded_at = ?, revoked_ms = ?, ends_at = ?
      WHERE out_trade_no = ?`)
    this.shiftLater = db.prepare(`UPDATE app_vip_orders SET starts_at = starts_at - ?, ends_at = ends_at - ?
      WHERE user_id = ? AND status = 'granted' AND out_trade_no != ? AND starts_at >= ?`)
    this.detach = db.prepare(`UPDATE app_vip_orders SET user_id = NULL, account_token = NULL,
      account_token_hash = ?, deleted_at = ? WHERE out_trade_no = ? AND user_id = ?`)
    this.detachTransaction = db.transaction((userId, now) => {
      let changed = 0
      for (const order of this.byUser.all(userId)) {
        if (!order.account_token) throw paymentError('PAYMENT_IDENTITY_MISMATCH')
        const fingerprint = accountTokenHash(order.account_token)
        changed += this.detach.run(fingerprint, now, order.out_trade_no, userId).changes
      }
      return changed
    })
    this.purgeRefunds = db.prepare(`DELETE FROM app_vip_refunds WHERE out_trade_no IN (
      SELECT out_trade_no FROM app_vip_orders WHERE user_id IS NULL AND deleted_at IS NOT NULL AND deleted_at <= ?)`)
    this.purgeOrders = db.prepare(`DELETE FROM app_vip_orders
      WHERE user_id IS NULL AND deleted_at IS NOT NULL AND deleted_at <= ?`)
    this.purgeDeletedTransaction = db.transaction((cutoff) => ({
      refunds: this.purgeRefunds.run(cutoff).changes,
      orders: this.purgeOrders.run(cutoff).changes,
    }))

    this.createTransaction = db.transaction((userId, requestId, config, now) => {
      const existing = this.byRequest.get(userId, requestId)
      if (existing) return existing
      if (!this.readExpiry.get(userId)) throw paymentError('VIP_USER_NOT_FOUND')
      if (this.pendingForUser.get(userId)) throw paymentError('VIP_ORDER_PENDING', '已有订单待确认，请先刷新结果')
      if (!['ios', 'android'].includes(config.platform) || !['sandbox', 'production'].includes(config.environment) ||
          !config.appId || !config.storeProductId || config.productId !== 'vip_month' || config.durationDays !== 30) {
        throw paymentError('PAYMENT_CONFIG_INVALID')
      }
      const id = `A${randomBytes(15).toString('hex')}`
      this.insert.run({ id, userId, requestId, platform: config.platform, environment: config.environment,
        appId: config.appId, storeProductId: config.storeProductId, accountToken: randomUUID(), now })
      return this.require(id)
    })
    this.recordTransaction = db.transaction((id, info, allowDeleted) => {
      const order = this.require(id)
      this.bindVerified(order, info, allowDeleted)
      return this.require(id)
    })
    this.grantTransaction = db.transaction((id, info, now) => {
      const order = this.require(id)
      this.bindVerified(order, info)
      if (!info.transactionId || info.status !== 'purchased') throw paymentError('PAYMENT_NOT_CONFIRMED')
      if (order.status === 'refunded' || order.platform_status === 'cancelled' ||
          order.closure_reason === 'platform_cancelled' || order.granted_at !== null || order.review_reason) return false
      const user = this.readExpiry.get(order.user_id)
      if (!user) throw paymentError('VIP_USER_NOT_FOUND')
      const startsAt = Math.max(now, user.vip_expires_at)
      const endsAt = startsAt + DURATION_MS
      this.setGrant.run(now, startsAt, endsAt, id)
      this.setExpiry.run(endsAt, now, order.user_id)
      return true
    })
    this.refundTransaction = db.transaction((id, info, now) => {
      const order = this.require(id)
      this.bindVerified(order, info, true)
      if (!info.transactionId || !['refunded', 'cancelled'].includes(info.status)) throw paymentError('REFUND_MISMATCH')
      const refundId = info.refundId || `transaction:${info.transactionId}`
      const amount = micros(info.refundAmountMicros ?? info.amountMicros)
      const result = info.refundResult || 'completed'
      const previous = this.refundById.get(order.platform, order.environment, refundId)
      if (previous && (previous.out_trade_no !== id ||
          (previous.amount_micros !== null && amount !== null && previous.amount_micros !== amount))) {
        throw paymentError('REFUND_MISMATCH')
      }
      if (previous?.result === 'completed') return false
      this.putRefund.run({ id, platform: order.platform, environment: order.environment, refundId,
        amountMicros: amount, currency: info.currency ?? order.currency, result,
        source: info.source || 'query', completedAt: info.refundedAt ?? now, now })
      if (result !== 'completed' || order.status === 'refunded') return false
      const paidAmount = order.amount_micros ?? info.amountMicros ?? null
      if (info.partialRefund || (paidAmount !== null && amount !== null && BigInt(amount) !== BigInt(paidAmount))) {
        this.review.run('PARTIAL_REFUND', id)
        return false
      }
      // Only this order's unused interval is removed. Later App orders shift by
      // that interval; consumed time and the independent WeChat ledger stay intact.
      const remaining = order.granted_at !== null ? Math.max(0, order.ends_at - Math.max(now, order.starts_at)) : 0
      if (remaining && order.user_id) {
        this.shiftLater.run(remaining, remaining, order.user_id, id, order.ends_at)
        const user = this.readExpiry.get(order.user_id)
        if (!user) throw paymentError('VIP_USER_NOT_FOUND')
        this.setExpiry.run(Math.max(0, user.vip_expires_at - remaining), now, order.user_id)
      }
      this.revoke.run(now, remaining, order.ends_at === null ? null : order.ends_at - remaining, id)
      return true
    })
  }

  require(id) {
    const order = this.byId.get(id)
    if (!order) throw paymentError('VIP_ORDER_NOT_FOUND', '未找到该订单')
    return order
  }

  bindVerified(order, info, allowDeleted = false) {
    if (order.deleted_at !== null || !order.user_id) {
      if (!allowDeleted) throw paymentError('APP_ACCOUNT_DELETED')
      if (!this.matchesDeletedAccount(order, info)) throw paymentError('PAYMENT_IDENTITY_MISMATCH')
    } else if (!info.accountToken || info.accountToken !== order.account_token) throw paymentError('PAYMENT_IDENTITY_MISMATCH')
    if (info.platform !== order.platform || info.environment !== order.environment || info.appId !== order.app_id ||
        info.storeProductId !== order.store_product_id || info.quantity !== 1 ||
        !['pending', 'purchased', 'refunded', 'cancelled'].includes(info.status)) throw paymentError('PAYMENT_ORDER_MISMATCH')
    for (const [key, column, statement] of [
      ['transactionId', 'transaction_id', this.byTransaction], ['purchaseToken', 'purchase_token', this.byPurchaseToken],
    ]) {
      if (info[key] == null) continue
      if (typeof info[key] !== 'string' || !info[key] || (order[column] && order[column] !== info[key])) {
        throw paymentError('PLATFORM_ORDER_MISMATCH')
      }
      const owner = statement.get(order.platform, order.environment, info[key])
      if (owner && owner.out_trade_no !== order.out_trade_no) throw paymentError('PAYMENT_TRANSACTION_CLAIMED')
    }
    const amountMicros = micros(info.amountMicros)
    if ((info.currency != null && !/^[A-Z]{3}$/.test(info.currency)) ||
        (order.currency && info.currency && order.currency !== info.currency) ||
        (order.amount_micros !== null && amountMicros !== null && order.amount_micros !== amountMicros)) {
      throw paymentError('PAYMENT_AMOUNT_MISMATCH')
    }
    this.setPlatform.run({ id: order.out_trade_no, transactionId: info.transactionId ?? null,
      purchaseToken: info.purchaseToken ?? null, currency: info.currency ?? null, amountMicros,
      purchasedAt: info.purchasedAt ?? null, status: info.status })
  }

  matchesDeletedAccount(order, info) {
    return typeof info.accountToken === 'string' && Boolean(info.accountToken) &&
      accountTokenHash(info.accountToken) === order.account_token_hash
  }

  findDeletedByAccountToken(platform, environment, token) {
    if (typeof token !== 'string' || !token) return undefined
    return this.byDeletedTokenHash.get(platform, environment, accountTokenHash(token))
  }

  create(userId, requestId, config, now) { return this.createTransaction.immediate(userId, requestId, config, now) }
  recordVerified(id, info, { allowDeleted = false } = {}) { return this.recordTransaction.immediate(id, info, allowDeleted) }
  grantVerified(id, info, now) { return this.grantTransaction.immediate(id, info, now) }
  refundVerified(id, info, now) { return this.refundTransaction.immediate(id, info, now) }
  markFinished(id, now) { return this.ack.run(now, id).changes > 0 }
  markChecked(id, now, nextAt, error = null) { this.checked.run(now, nextAt, error, id) }
  close(id) { return this.closeOrder.run(id).changes > 0 }
  cancelNative(id, now, reason = 'native_cancelled') {
    if (!['native_cancelled', 'purchase_not_started'].includes(reason)) throw paymentError('PAYMENT_CANCELLATION_INVALID')
    return this.nativeCancellation.run(now, reason, id).changes > 0
  }
  // Reserved for account deletion's enclosing transaction. This does not delete
  // the account: it removes its mapping while retaining financial deduplication.
  detachUserOrders(userId, now) { return this.detachTransaction.immediate(userId, now) }
  purgeDeletedBefore(cutoff) { return this.purgeDeletedTransaction.immediate(cutoff) }
}

module.exports = AppPaymentLedger
