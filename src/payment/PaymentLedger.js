const { randomBytes } = require('crypto')
const { DAY_MS, paymentError } = require('./config')

// Uses UserStore's connection. All entitlement changes and ledger writes commit together.
class PaymentLedger {
  constructor(db) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS vip_orders (
        out_trade_no TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(user_id),
        request_id TEXT NOT NULL,
        app_id TEXT NOT NULL, openid TEXT NOT NULL, offer_id TEXT NOT NULL,
        product_id TEXT NOT NULL, price_fen INTEGER NOT NULL CHECK(price_fen = 1000),
        quantity INTEGER NOT NULL CHECK(quantity = 1), duration_ms INTEGER NOT NULL,
        currency TEXT NOT NULL CHECK(currency = 'CNY'), env INTEGER NOT NULL CHECK(env = 0),
        attach TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','granted','refunded','closed')),
        wx_order_id TEXT UNIQUE, channel_order_id TEXT, wxpay_order_id TEXT,
        platform_status INTEGER, order_type INTEGER,
        created_at INTEGER NOT NULL, paid_at INTEGER, granted_at INTEGER,
        starts_at INTEGER, ends_at INTEGER, revoked_ms INTEGER NOT NULL DEFAULT 0,
        delivery_ack_at INTEGER, refunded_at INTEGER,
        review_reason TEXT, last_error TEXT, last_checked_at INTEGER,
        next_check_at INTEGER NOT NULL,
        UNIQUE(user_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS vip_orders_due ON vip_orders(next_check_at);
      CREATE INDEX IF NOT EXISTS vip_orders_user ON vip_orders(user_id, created_at);
      CREATE TABLE IF NOT EXISTS vip_refunds (
        refund_id TEXT PRIMARY KEY NOT NULL,
        out_trade_no TEXT NOT NULL REFERENCES vip_orders(out_trade_no),
        amount_fen INTEGER NOT NULL, result_code INTEGER NOT NULL,
        source TEXT NOT NULL, completed_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL
      );
    `)
    this.byId = db.prepare('SELECT * FROM vip_orders WHERE out_trade_no = ?')
    this.byRequest = db.prepare('SELECT * FROM vip_orders WHERE user_id = ? AND request_id = ?')
    this.byPlatform = db.prepare('SELECT * FROM vip_orders WHERE wx_order_id = ?')
    this.latest = db.prepare('SELECT * FROM vip_orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    this.insert = db.prepare(`INSERT INTO vip_orders
      (out_trade_no,user_id,request_id,app_id,openid,offer_id,product_id,price_fen,quantity,duration_ms,currency,env,attach,created_at,next_check_at)
      VALUES (@out_trade_no,@user_id,@request_id,@app_id,@openid,@offer_id,@product_id,@price_fen,1,@duration_ms,'CNY',0,@attach,@created_at,@next_check_at)`)
    this.readExpiry = db.prepare('SELECT vip_expires_at FROM users WHERE user_id = ?')
    this.setExpiry = db.prepare('UPDATE users SET vip_expires_at = ?, updated_at = ? WHERE user_id = ?')
    this.setGrant = db.prepare("UPDATE vip_orders SET status = 'granted', granted_at = ?, starts_at = ?, ends_at = ? WHERE out_trade_no = ?")
    this.setPlatform = db.prepare(`UPDATE vip_orders SET wx_order_id = ?, channel_order_id = ?, wxpay_order_id = ?,
      platform_status = ?, order_type = ?, paid_at = ? WHERE out_trade_no = ?`)
    this.ack = db.prepare('UPDATE vip_orders SET delivery_ack_at = ? WHERE out_trade_no = ?')
    this.closeOrder = db.prepare("UPDATE vip_orders SET status = 'closed' WHERE out_trade_no = ? AND status = 'pending'")
    this.review = db.prepare('UPDATE vip_orders SET review_reason = ? WHERE out_trade_no = ?')
    this.checked = db.prepare('UPDATE vip_orders SET last_checked_at = ?, next_check_at = ?, last_error = ? WHERE out_trade_no = ?')
    this.due = db.prepare(`SELECT * FROM vip_orders WHERE next_check_at <= ? AND
      (status = 'pending' OR (status = 'granted' AND (delivery_ack_at IS NULL OR ends_at > ?)))
      ORDER BY next_check_at, out_trade_no LIMIT ?`)
    this.refundById = db.prepare('SELECT * FROM vip_refunds WHERE refund_id = ?')
    this.putRefund = db.prepare(`INSERT INTO vip_refunds VALUES (@id,@orderId,@amount,@result,@source,@completedAt,@now)
      ON CONFLICT(refund_id) DO UPDATE SET result_code=excluded.result_code, completed_at=excluded.completed_at
      WHERE vip_refunds.result_code != 0`)
    this.revoke = db.prepare("UPDATE vip_orders SET status='refunded', refunded_at=?, revoked_ms=?, ends_at=? WHERE out_trade_no=?")
    this.shiftLater = db.prepare(`UPDATE vip_orders SET starts_at=starts_at-?, ends_at=ends_at-?
      WHERE user_id=? AND status='granted' AND out_trade_no!=? AND starts_at>=?`)
    this.grantTransaction = db.transaction((id, now) => {
      const order = this.require(id)
      if (order.status === 'refunded' || order.granted_at || order.review_reason) return false
      const startsAt = Math.max(this.readExpiry.get(order.user_id).vip_expires_at, now)
      const endsAt = startsAt + order.duration_ms
      this.setGrant.run(now, startsAt, endsAt, id)
      this.setExpiry.run(endsAt, now, order.user_id)
      return true
    })
    this.refundTransaction = db.transaction((input) => {
      const order = this.require(input.orderId)
      const previous = this.refundById.get(input.id)
      if (previous && (previous.out_trade_no !== input.orderId || previous.amount_fen !== input.amount)) {
        throw paymentError('REFUND_MISMATCH')
      }
      if (previous?.result_code === 0) return false
      this.putRefund.run(input)
      if (input.result !== 0 || order.status === 'refunded') return false
      if (input.amount !== order.price_fen) {
        this.review.run('PARTIAL_REFUND', input.orderId)
        return false
      }
      // Revoke only unused time at server confirmation; never charge later orders
      // for an old entitlement that has already been consumed.
      const at = input.now
      const remaining = order.granted_at ? Math.max(0, order.ends_at - Math.max(at, order.starts_at)) : 0
      if (remaining) {
        this.shiftLater.run(remaining, remaining, order.user_id, input.orderId, order.ends_at)
        const expiry = this.readExpiry.get(order.user_id).vip_expires_at
        this.setExpiry.run(Math.max(0, expiry - remaining), input.now, order.user_id)
      }
      this.revoke.run(at, remaining, order.ends_at == null ? null : order.ends_at - remaining, input.orderId)
      return true
    })
  }

  require(id) {
    const order = this.byId.get(id)
    if (!order) throw paymentError('VIP_ORDER_NOT_FOUND', '未找到该订单')
    return order
  }

  create(userId, requestId, openid, config, now) {
    const existing = this.byRequest.get(userId, requestId)
    if (existing) return existing
    const id = `V${randomBytes(15).toString('hex')}`
    this.insert.run({ out_trade_no: id, user_id: userId, request_id: requestId,
      app_id: config.appId, openid, offer_id: config.offerId, product_id: config.productId,
      price_fen: config.priceFen, duration_ms: config.durationDays * DAY_MS,
      attach: JSON.stringify({ order: id, product: config.productId, quantity: 1, price: config.priceFen }),
      created_at: now, next_check_at: now })
    return this.require(id)
  }

  grant(id, now) { return this.grantTransaction.immediate(id, now) }
  refund(input) { return this.refundTransaction.immediate(input) }

  platform(order, info) {
    if (order.wx_order_id && order.wx_order_id !== info.wx_order_id) throw paymentError('PLATFORM_ORDER_MISMATCH')
    this.setPlatform.run(info.wx_order_id, info.channel_order_id || null, info.wxpay_order_id || null,
      info.status, info.order_type, (info.paid_time || 0) * 1000, order.out_trade_no)
  }
}

module.exports = PaymentLedger
