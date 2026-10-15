const { EventEmitter } = require('events')
const { paymentError, DAY_MS } = require('./config')

const RETRY_MS = 5 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const PLATFORMS = new Set(['ios', 'android'])

function publicAppOrder(order) {
  if (!order) return null
  return {
    outTradeNo: order.out_trade_no, requestId: order.request_id, platform: order.platform,
    productId: order.product_id, storeProductId: order.store_product_id,
    durationDays: order.duration_ms / DAY_MS,
    status: order.status === 'refunded' ? 'refunded' : order.review_reason ? 'review' : order.status,
    createdAt: order.created_at, grantedAt: order.granted_at, startsAt: order.starts_at, endsAt: order.ends_at,
    refundedAt: order.refunded_at, finishedAt: order.platform_ack_at,
    currency: order.currency, amountMicros: order.amount_micros,
    nativeCancelledAt: order.client_cancelled_at || null,
  }
}
function checkInterval(order, now) {
  if (order.status === 'granted') return order.platform_ack_at ? DAY_MS : RETRY_MS
  if (order.status === 'pending' && now - order.created_at >= DAY_MS) return DAY_MS
  if (order.status === 'pending' && now - order.created_at >= HOUR_MS) return HOUR_MS
  return RETRY_MS
}

// Same integration shape as PaymentService. Only verified platform data enters the App ledger.
class AppPaymentService extends EventEmitter {
  constructor({ userStore, config, client, now = Date.now, logger = console }) {
    super()
    this.store = userStore
    this.ledger = userStore.appPayments
    this.config = config
    this.client = client || new (require('./AppStoreClient').AppStoreClient)({ config })
    this.now = now
    this.logger = logger
    this.locks = new Map()
    this.sweepPromise = null
    this.timer = null
    this.stopped = false
  }

  get product() {
    const purchasablePlatforms = [...PLATFORMS].filter((platform) => this.canSell(platform))
    return { productId: this.config.productId, durationDays: 30, priceFen: undefined,
      purchasable: purchasablePlatforms.length > 0, purchasablePlatforms,
      storeProducts: Object.fromEntries([...PLATFORMS].map((platform) => [platform, this.config.platforms[platform].storeProductId])) }
  }
  canSell(platform) {
    const config = this.config.platforms[platform]
    return Boolean(!this.stopped && this.config.enabled && config?.enabled && config.configured)
  }
  exclusive(key, operation) {
    const prior = this.locks.get(key) || Promise.resolve()
    const pending = prior.catch(() => {}).then(operation)
    this.locks.set(key, pending)
    return pending.finally(() => { if (this.locks.get(key) === pending) this.locks.delete(key) })
  }
  platformConfig(platform) {
    if (!PLATFORMS.has(platform)) throw paymentError('PAYMENT_PLATFORM_INVALID', '不支持的商店渠道')
    const config = this.config.platforms[platform]
    if (!config?.configured) throw paymentError('PAYMENT_NOT_CONFIGURED', '商店验证暂不可用')
    return config
  }
  assertActive(stillActive) {
    if (!stillActive()) throw paymentError('SESSION_REPLACED', '连接已变化，请重新确认')
    if (this.stopped) throw paymentError('PAYMENT_STOPPED')
  }
  async create(userId, payload = {}, stillActive = () => true) {
    if (!/^[A-Za-z0-9-]{16,80}$/.test(payload.requestId || '')) throw paymentError('REQUEST_ID_INVALID', '请重新发起购买')
    return this.exclusive(`user:${userId}`, () => {
      this.assertActive(stillActive)
      const existing = this.ledger.byRequest.get(userId, payload.requestId)
      if (existing) return { order: publicAppOrder(existing) }
      if (!this.canSell(payload.platform)) throw paymentError('VIP_NOT_FOR_SALE', '暂未开放开通')
      if (payload.productId !== this.config.productId) throw paymentError('VIP_PRODUCT_CHANGED', '商品信息已变化，请刷新后确认')
      const platform = this.platformConfig(payload.platform)
      const order = this.ledger.create(userId, payload.requestId, { ...platform, platform: payload.platform,
        productId: this.config.productId, durationDays: 30 }, this.now())
      return { order: publicAppOrder(order), payment: {
        platform: order.platform, storeProductId: order.store_product_id, accountToken: order.account_token,
      } }
    })
  }
  findOwn(userId, payload = {}) {
    let order
    if (payload.outTradeNo) order = this.ledger.byId.get(String(payload.outTradeNo))
    else if (payload.requestId) order = this.ledger.byRequest.get(userId, String(payload.requestId))
    else order = this.ledger.pendingForUser.get(userId) || this.ledger.latest.get(userId)
    if (!order && !payload.outTradeNo) return null
    if (!order || order.user_id !== userId) throw paymentError('VIP_ORDER_NOT_FOUND', '未找到该订单')
    return order
  }
  async queryOwn(userId, payload = {}, stillActive = () => true) {
    if (payload.restore) return this.restore(userId, stillActive)
    const creating = this.locks.get(`user:${userId}`)
    if (creating) await creating.catch(() => {})
    this.assertActive(stillActive)
    if ((payload.nativeCancelled === true || payload.nativeFinished === true) && !payload.outTradeNo) {
      throw paymentError('VIP_ORDER_NOT_FOUND', '请指定当前购买订单')
    }
    if (payload.purchaseNotStarted === true && !payload.outTradeNo && !payload.requestId) {
      throw paymentError('VIP_ORDER_NOT_FOUND', '请指定尚未发起付款的请求')
    }
    let order = this.findOwn(userId, payload)
    if (!order) return { order: null }
    if (payload.nativeCancelled === true || payload.purchaseNotStarted === true) {
      // Explicit native USER_CANCELLED or a persisted "not invoked" intent may release this attempt.
      // A later verified payment still grants its original order; neither marker proves a refund.
      order = await this.exclusive(order.out_trade_no, () => {
        this.assertActive(stillActive)
        this.ledger.cancelNative(order.out_trade_no, this.now(), payload.purchaseNotStarted === true ? 'purchase_not_started' : 'native_cancelled')
        return this.ledger.require(order.out_trade_no)
      })
    }
    if (payload.nativeFinished === true) {
      order = await this.exclusive(order.out_trade_no, () => {
        this.assertActive(stillActive)
        const latest = this.ledger.require(order.out_trade_no)
        if (latest.platform !== 'ios' || latest.status !== 'granted') throw paymentError('PAYMENT_NOT_CONFIRMED')
        // A device receipt for StoreKit finish releases the invocation lock. It grants no entitlement;
        // Android completion always comes from verified server-side consumption instead.
        this.ledger.markFinished(latest.out_trade_no, this.now())
        return this.ledger.require(latest.out_trade_no)
      })
    }
    return { order: publicAppOrder(await this.recover(order)) }
  }
  async restore(userId, stillActive = () => true) {
    this.assertActive(stillActive)
    const orders = []
    for (const order of this.ledger.byUser.all(userId)) {
      this.assertActive(stillActive)
      orders.push(publicAppOrder(await this.recover(order)))
    }
    return { order: publicAppOrder(this.ledger.pendingForUser.get(userId) || this.ledger.latest.get(userId)), orders }
  }
  async recover(order) {
    try { return await this.reconcile(order.out_trade_no) }
    catch (error) {
      const latest = this.ledger.require(order.out_trade_no)
      // Delivery may already be durable while consume/finish or a later platform poll fails.
      if (!['granted', 'refunded', 'closed', 'review'].includes(publicAppOrder(latest).status)) throw error
      this.warn(order.out_trade_no, error.code || 'PAYMENT_ERROR')
      return latest
    }
  }
  locator(order) {
    return { platform: order.platform, environment: order.environment, appId: order.app_id,
      storeProductId: order.store_product_id, transactionId: order.transaction_id || undefined,
      purchaseToken: order.purchase_token || undefined }
  }
  validate(order, verified) {
    const identityMatches = verified && (order.deleted_at != null
      ? this.ledger.matchesDeletedAccount(order, verified) : verified.accountToken === order.account_token)
    if (!verified || verified.platform !== order.platform || verified.environment !== order.environment ||
      verified.appId !== order.app_id || verified.storeProductId !== order.store_product_id ||
      !identityMatches || verified.quantity !== 1 ||
      !['pending', 'purchased', 'refunded', 'cancelled'].includes(verified.status)) {
      throw paymentError('PAYMENT_ORDER_MISMATCH', '商店交易与当前订单不一致')
    }
  }
  async applyVerified(order, verified, { allowDeleted = false } = {}) {
    // A network query may overlap account deletion. Re-read before deciding whether delivery is allowed.
    order = this.ledger.require(order.out_trade_no)
    const deleted = order.deleted_at != null || !order.user_id
    if (deleted && !allowDeleted) throw paymentError('APP_ACCOUNT_DELETED')
    this.validate(order, verified)
    if (deleted) {
      if (verified.status === 'refunded' || verified.status === 'cancelled' && order.paid_at != null) {
        this.ledger.refundVerified(order.out_trade_no, { ...verified,
          refundId: verified.refundId || `${verified.platform}:${verified.transactionId}:revoked`,
          refundedAt: verified.refundedAt || this.now(), source: 'platform' }, this.now())
      } else {
        this.ledger.recordVerified(order.out_trade_no, verified, { allowDeleted: true })
        if (verified.status === 'cancelled') this.ledger.close(order.out_trade_no)
      }
      // Deleted orders retain financial facts only. Never grant, consume, or recreate a user.
      return this.ledger.require(order.out_trade_no)
    }
    let changed = false
    if (verified.status === 'refunded' || verified.status === 'cancelled' && order.granted_at != null) {
      changed = this.ledger.refundVerified(order.out_trade_no, { ...verified,
        refundId: verified.refundId || `${verified.platform}:${verified.transactionId}:revoked`,
        refundedAt: verified.refundedAt || this.now(), source: 'platform' }, this.now())
    } else if (verified.status === 'purchased') {
      changed = this.ledger.grantVerified(order.out_trade_no, verified, this.now())
    } else {
      this.ledger.recordVerified(order.out_trade_no, verified, this.now())
      if (verified.status === 'cancelled') this.ledger.close(order.out_trade_no)
    }
    if (changed && order.user_id) this.emit('changed', order.user_id)
    const latest = this.ledger.require(order.out_trade_no)
    if (verified.status === 'purchased' && latest.status === 'granted' && !latest.platform_ack_at) {
      // Persist the grant before asking the platform to consume/acknowledge.
      let completed
      try {
        completed = await this.client.complete(verified)
      } catch (error) {
        error.deliveryPending = true
        throw error
      }
      if (completed.verified && ['refunded', 'cancelled'].includes(completed.verified.status)) {
        await this.applyVerified(this.ledger.require(order.out_trade_no), completed.verified, { allowDeleted: true })
      } else if (completed.finished) this.ledger.markFinished(order.out_trade_no, this.now())
    }
    return this.ledger.require(order.out_trade_no)
  }
  async confirmPurchase(userId, payload = {}, stillActive = () => true) {
    this.assertActive(stillActive)
    const platform = this.platformConfig(payload.platform)
    if (!payload.transactionId && !payload.purchaseToken) throw paymentError('PAYMENT_PROOF_REQUIRED', '缺少商店交易凭证')
    const verified = await this.client.verify({ platform: payload.platform, environment: platform.environment,
      appId: platform.appId, storeProductId: platform.storeProductId,
      transactionId: payload.transactionId, purchaseToken: payload.purchaseToken })
    this.assertActive(stillActive)
    const order = payload.outTradeNo ? this.ledger.byId.get(String(payload.outTradeNo))
      : this.ledger.byAccountToken.get(verified.platform, verified.environment, verified.accountToken)
    if (!order || order.user_id !== userId) throw paymentError('VIP_ORDER_NOT_FOUND', '未找到当前账号对应的订单')
    return { order: publicAppOrder(await this.exclusive(order.out_trade_no, async () => {
      this.assertActive(stillActive)
      try {
        const result = await this.applyVerified(this.ledger.require(order.out_trade_no), verified)
        this.scheduleCheck(order.out_trade_no)
        return result
      } catch (error) {
        this.scheduleCheck(order.out_trade_no, error.code || 'PAYMENT_ERROR')
        // Allow native finish after durable granting, while server-side completion retries independently.
        const latest = this.ledger.require(order.out_trade_no)
        if (error.deliveryPending && latest.status === 'granted' && !latest.platform_ack_at && verified.status === 'purchased') {
          this.warn(order.out_trade_no, error.code || 'PAYMENT_ERROR')
          return latest
        }
        throw error
      }
    })) }
  }
  reconcile(id, { force = false } = {}) {
    return this.exclusive(id, async () => {
      if (this.stopped) throw paymentError('PAYMENT_STOPPED')
      const order = this.ledger.require(id)
      // No transaction locator means outcome unknown. Never invent cancellation or initiate a purchase.
      if (!order.transaction_id && !order.purchase_token) { this.scheduleCheck(id); return order }
      this.platformConfig(order.platform)
      if (!force && order.last_checked_at && this.now() - order.last_checked_at < 2000 && !order.last_error) return order
      try {
        const verified = await this.client.verify(this.locator(order))
        if (this.stopped) throw paymentError('PAYMENT_STOPPED')
        await this.applyVerified(order, verified, { allowDeleted: true })
        this.scheduleCheck(id)
        return this.ledger.require(id)
      } catch (error) {
        this.scheduleCheck(id, error.code || 'PAYMENT_ERROR')
        throw error
      }
    })
  }
  async notification(platform, body, headers) {
    this.platformConfig(platform)
    const notification = await this.client.verifyNotification(platform, { body, headers })
    if (notification.test || !notification.locator) return
    const verified = await this.client.verify(notification.locator)
    if (this.stopped) throw paymentError('PAYMENT_STOPPED')
    const order = this.ledger.byAccountToken.get(verified.platform, verified.environment, verified.accountToken) ||
      this.ledger.findDeletedByAccountToken(verified.platform, verified.environment, verified.accountToken) ||
      (verified.transactionId && this.ledger.byTransaction.get(verified.platform, verified.environment, verified.transactionId)) ||
      (verified.purchaseToken && this.ledger.byPurchaseToken.get(verified.platform, verified.environment, verified.purchaseToken))
    // A verified historical notification can outlive the seven-day deletion retention.
    // Without a retained order it conveys no deliverable ownership; acknowledge without creating data.
    if (!order) return
    await this.exclusive(order.out_trade_no, async () => {
      if (this.stopped) throw paymentError('PAYMENT_STOPPED')
      const current = this.ledger.byId.get(order.out_trade_no)
      if (!current) return // Retention may have purged it while waiting for another operation.
      try { await this.applyVerified(current, verified, { allowDeleted: true }); this.scheduleCheck(order.out_trade_no) }
      catch (error) { this.scheduleCheck(order.out_trade_no, error.code || 'PAYMENT_ERROR'); throw error }
    })
  }
  scheduleCheck(id, error = null) {
    const order = this.ledger.require(id), now = this.now()
    this.ledger.markChecked(id, now, now + checkInterval(order, now), error)
  }
  warn(id, code) { this.logger.warn('[app-vip-payment]', { order: id, code }) }
  sweep() {
    if (this.sweepPromise) return this.sweepPromise
    this.sweepPromise = (async () => {
      if (!this.config.configured || this.stopped) return
      const cutoff = this.now()
      for (let batch = 0; batch < 10 && !this.stopped; batch++) {
        const orders = this.ledger.due.all(cutoff, this.now(), 100)
        if (!orders.length) break
        for (const order of orders) {
          if (this.stopped) break
          try { await this.reconcile(order.out_trade_no, { force: true }) }
          catch (error) { this.warn(order.out_trade_no, error.code || 'PAYMENT_ERROR') }
        }
      }
    })().finally(() => { this.sweepPromise = null })
    return this.sweepPromise
  }
  start() {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.sweep().catch(() => this.warn('', 'SWEEP_FAILED')), RETRY_MS)
    this.timer.unref()
    void this.sweep().catch(() => this.warn('', 'SWEEP_FAILED'))
  }
  stop() {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = null
    return Promise.allSettled([...this.locks.values(), ...(this.sweepPromise ? [this.sweepPromise] : [])])
  }
}

module.exports = { AppPaymentService, publicAppOrder }
