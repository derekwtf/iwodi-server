const { EventEmitter } = require('events')
const { paymentError, DAY_MS } = require('./config')
const { WechatPaymentClient } = require('./WechatPaymentClient')

const RETRY_MS = 5 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function checkInterval(order, now) {
  if (order.status === 'granted') return order.delivery_ack_at ? DAY_MS : RETRY_MS
  if (order.status === 'pending') {
    const age = now - order.created_at
    if (age >= DAY_MS) return DAY_MS
    if (age >= HOUR_MS) return HOUR_MS
  }
  return RETRY_MS
}

function publicOrder(order) {
  if (!order) return null
  return { outTradeNo: order.out_trade_no, requestId: order.request_id, productId: order.product_id,
    priceFen: order.price_fen, durationDays: order.duration_ms / DAY_MS,
    status: order.status === 'refunded' ? 'refunded' : order.review_reason ? 'review' : order.status, createdAt: order.created_at,
    grantedAt: order.granted_at, startsAt: order.starts_at, endsAt: order.ends_at,
    refundedAt: order.refunded_at, platformStatus: order.platform_status }
}

class PaymentService extends EventEmitter {
  constructor({ userStore, config, fetchWechatSession, client, now = Date.now, logger = console }) {
    super()
    this.store = userStore
    this.ledger = userStore.payments
    this.config = config
    this.fetchSession = fetchWechatSession
    this.client = client || new WechatPaymentClient(config)
    this.now = now
    this.logger = logger
    this.locks = new Map()
    this.creating = new Map()
    this.sweepPromise = null
  }

  get product() {
    return { productId: this.config.productId, priceFen: this.config.priceFen,
      durationDays: 30, purchasable: this.config.enabled && this.config.configured }
  }

  exclusive(key, operation) {
    const prior = this.locks.get(key) || Promise.resolve()
    const pending = prior.catch(() => {}).then(operation)
    this.locks.set(key, pending)
    return pending.finally(() => { if (this.locks.get(key) === pending) this.locks.delete(key) })
  }

  async create(userId, payload = {}, stillActive = () => true) {
    if (!/^[A-Za-z0-9-]{16,80}$/.test(payload.requestId || '')) throw paymentError('REQUEST_ID_INVALID', '请重新发起购买')
    const existing = this.ledger.byRequest.get(userId, payload.requestId)
    // A recovery returns the same order but never another payment invocation.
    if (existing) return { order: publicOrder(existing) }
    if (!this.product.purchasable) throw paymentError('VIP_NOT_FOR_SALE', '暂未开放开通')
    if (payload.priceFen !== this.config.priceFen || payload.productId !== this.config.productId) {
      throw paymentError('VIP_PRICE_CHANGED', '商品信息已变化，请刷新后确认')
    }
    if (this.creating.has(userId)) throw paymentError('VIP_ORDER_CREATING', '正在创建订单，请稍后刷新结果')
    const work = (async () => {
      const session = await this.fetchSession(payload.code)
      if (!stillActive()) throw paymentError('SESSION_REPLACED', '连接已变化，请重新确认')
      if (!session.sessionKey || this.store.find.get('wechat_mini_program', this.config.appId, session.openid)?.user_id !== userId) {
        throw paymentError('PAYMENT_IDENTITY_MISMATCH', '微信身份已变化，请重新登录')
      }
      const order = this.ledger.create(userId, payload.requestId, session.openid, this.config, this.now())
      return { order: publicOrder(order), payment: this.client.sign(order, session.sessionKey) }
    })()
    this.creating.set(userId, work)
    try { return await work } finally { if (this.creating.get(userId) === work) this.creating.delete(userId) }
  }

  async queryOwn(userId, payload = {}) {
    // Wait for an in-flight code exchange before declaring a timed-out request absent.
    const creating = this.creating.get(userId)
    if (creating) await creating.catch(() => {})
    let order
    if (payload.outTradeNo) order = this.ledger.byId.get(String(payload.outTradeNo))
    else if (payload.requestId) order = this.ledger.byRequest.get(userId, String(payload.requestId))
    else order = this.ledger.latest.get(userId)
    if (!order && !payload.outTradeNo) return { order: null }
    if (!order || order.user_id !== userId) throw paymentError('VIP_ORDER_NOT_FOUND', '未找到该订单')
    let current
    try { current = await this.reconcile(order.out_trade_no) }
    catch (error) {
      // Reconciliation can commit a grant before the platform acknowledgement fails.
      current = this.ledger.require(order.out_trade_no)
      if (!['granted', 'refunded', 'closed', 'review'].includes(publicOrder(current).status)) throw error
      this.warn(order.out_trade_no, error.code || 'PAYMENT_ERROR')
    }
    return { order: publicOrder(current) }
  }

  validate(order, info) {
    if (!info || info.order_id !== order.out_trade_no || info.env_type !== 1 ||
      ![0, 7].includes(info.order_type) || !info.wx_order_id ||
      !Number.isInteger(info.status) || info.status < 0 || info.status > 10) throw paymentError('PAYMENT_ORDER_MISMATCH')
    // query_order has no product/quantity fields. These are bound to this unique
    // order's immutable, server-signed snapshot. OpenID is supplied server-side.
    if (info.order_fee !== order.price_fen || order.quantity !== 1 || order.env !== 0 ||
      order.app_id !== this.config.appId) throw paymentError('PAYMENT_AMOUNT_MISMATCH')
    if (![0, 1, 6].includes(info.status) && (info.paid_fee !== order.price_fen ||
      !Number.isInteger(info.left_fee) || info.left_fee < 0 || info.left_fee > order.price_fen)) {
      throw paymentError('PAYMENT_AMOUNT_MISMATCH')
    }
  }

  // Only this path confirms payment: both the push and client/background query use it.
  async confirm(order, info) {
    this.validate(order, info)
    this.ledger.platform(order, info)
    let changed = false
    if (![0, 1, 6].includes(info.status) && info.left_fee < order.price_fen) {
      changed = this.ledger.refund({ id: `query:${info.wx_order_id}:${info.left_fee}`,
        orderId: order.out_trade_no, amount: order.price_fen - info.left_fee, result: 0,
        source: 'query', completedAt: this.now(), now: this.now() })
      if (info.left_fee > 0) this.warn(order.out_trade_no, 'PARTIAL_REFUND')
    } else if ([5, 8, 9, 10].includes(info.status)) {
      // Never infer a full refund from status alone when the amount is contradictory.
      this.ledger.review.run('REFUND_AMOUNT_UNCONFIRMED', order.out_trade_no)
      this.warn(order.out_trade_no, 'REFUND_AMOUNT_UNCONFIRMED')
    } else if ([2, 3, 4, 7].includes(info.status)) {
      // Refund failure (status 7) still permits delivery after the amount/refund checks above.
      changed = this.ledger.grant(order.out_trade_no, this.now())
    } else if (info.status === 6) this.ledger.closeOrder.run(order.out_trade_no)
    if (changed) this.emit('changed', order.user_id)
    let latest = this.ledger.require(order.out_trade_no)
    if (latest.status === 'granted' && !latest.delivery_ack_at) {
      if (info.status !== 4) await this.client.provide(latest)
      this.ledger.ack.run(this.now(), order.out_trade_no)
      latest = this.ledger.require(order.out_trade_no)
    }
    return latest
  }

  reconcile(id, { force = false } = {}) {
    return this.exclusive(id, async () => {
      const order = this.ledger.require(id)
      if (!this.config.configured) throw paymentError('PAYMENT_NOT_CONFIGURED')
      // Coalesce page polls and concurrent push queries; background uses due dates.
      if (!force && order.last_checked_at && this.now() - order.last_checked_at < 2000 && !order.last_error) return order
      try {
        const response = await this.client.query(order)
        await this.confirm(order, response.order)
      } catch (error) {
        this.scheduleCheck(id, error.code || 'PAYMENT_ERROR')
        throw error
      }
      this.scheduleCheck(id)
      return this.ledger.require(id)
    })
  }

  scheduleCheck(id, error = null) {
    // Confirmation may have granted entitlement before the platform acknowledgement failed.
    const latest = this.ledger.require(id), now = this.now()
    this.ledger.checked.run(now, now + checkInterval(latest, now), error, id)
  }

  async event(message) {
    if (message.Event === 'xpay_goods_deliver_notify') {
      const order = this.ledger.require(message.OutTradeNo)
      const goods = message.GoodsInfo
      if (message.OpenId !== order.openid || message.Env !== order.env || !goods ||
        goods.ProductId !== order.product_id || goods.Quantity !== order.quantity ||
        goods.OrigPrice !== order.price_fen || goods.ActualPrice !== order.price_fen ||
        goods.Attach !== order.attach) throw paymentError('DELIVERY_MISMATCH')
      await this.reconcile(order.out_trade_no, { force: true })
      const latest = this.ledger.require(order.out_trade_no)
      if (!['granted', 'refunded'].includes(latest.status)) throw paymentError('DELIVERY_NOT_CONFIRMED')
      return { ErrCode: 0, ErrMsg: 'success' }
    }
    if (message.Event === 'xpay_refund_notify') {
      let order = this.ledger.byId.get(message.MchOrderId || '') || this.ledger.byPlatform.get(message.WxOrderId || '')
      if (!order && message.Attach) {
        try { order = this.ledger.byId.get(JSON.parse(message.Attach).order) } catch (_) { /* reject below */ }
      }
      if (!order || message.OpenId !== order.openid || !message.WxRefundId ||
        !Number.isInteger(message.RefundFee) || message.RefundFee <= 0 || message.RefundFee > order.price_fen ||
        !Number.isInteger(message.RetCode) ||
        (order.wx_order_id && message.WxOrderId !== order.wx_order_id)) throw paymentError('REFUND_MISMATCH')
      await this.exclusive(order.out_trade_no, () => {
        const changed = this.ledger.refund({ id: message.WxRefundId, orderId: order.out_trade_no,
          amount: message.RefundFee, result: message.RetCode, source: 'notification',
          completedAt: Number(message.RefundSuccTimestamp) > 0 ? message.RefundSuccTimestamp * 1000 : this.now(), now: this.now() })
        if (changed) this.emit('changed', order.user_id)
        if (message.RetCode === 0 && message.RefundFee !== order.price_fen) this.warn(order.out_trade_no, 'PARTIAL_REFUND')
      })
      return { ErrCode: 0, ErrMsg: 'success' }
    }
    if (message.Event === 'xpay_subscribe_ios_refund_query_notify') {
      // No external call: Apple requires an answer within three seconds.
      const order = this.ledger.byId.get(message.pay_order_id || '') || this.ledger.byPlatform.get(message.pay_order_id || '')
      if (!order || message.product_id !== order.product_id || String(message.p_count) !== String(order.quantity)) {
        return { result_code: 0, result_info: '建议退款', evidence: '未能匹配已发放的本地订单，请平台核实' }
      }
      const used = order.granted_at && this.now() > order.starts_at && order.status !== 'refunded'
      return { result_code: used ? 1 : 0, result_info: used ? '权益已开始使用，请人工审核' : '建议退款',
        evidence: JSON.stringify({ order: order.out_trade_no, grantedAt: order.granted_at,
          startsAt: order.starts_at, endsAt: order.ends_at, usedMs: used ? Math.min(this.now(), order.ends_at) - order.starts_at : 0 }) }
    }
    return null
  }

  warn(id, code) { this.logger.warn('[vip-payment]', { order: id, code }) }

  sweep() {
    if (this.sweepPromise) return this.sweepPromise
    this.sweepPromise = (async () => {
      if (!this.config.configured) return
      const cutoff = this.now()
      for (let batch = 0; batch < 10; batch += 1) {
        const orders = this.ledger.due.all(cutoff, this.now(), 100)
        if (!orders.length) break
        for (const order of orders) {
          try { await this.reconcile(order.out_trade_no, { force: true }) }
          catch (error) { this.warn(order.out_trade_no, error.code || 'PAYMENT_ERROR') }
        }
      }
    })().finally(() => { this.sweepPromise = null })
    return this.sweepPromise
  }

  start() {
    this.timer = setInterval(() => this.sweep().catch(() => this.warn('', 'SWEEP_FAILED')), 5 * 60 * 1000)
    this.timer.unref()
    this.sweep().catch(() => this.warn('', 'SWEEP_FAILED'))
  }
  stop() { clearInterval(this.timer) }
}

module.exports = { PaymentService, publicOrder }
