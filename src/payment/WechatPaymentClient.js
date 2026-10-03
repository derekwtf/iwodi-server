const { createHmac } = require('crypto')
const { paymentError } = require('./config')

const hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex')
const paySignature = (path, body, key) => hmac(key, `${path}&${body}`)

class WechatPaymentClient {
  constructor(config, { fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config
    this.fetch = fetchImpl
    this.now = now
    this.cachedToken = null
    this.tokenRequest = null
  }

  async post(url, body) {
    try {
      const response = await this.fetch(url, { method: 'POST', body,
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw paymentError('WECHAT_PAYMENT_UNAVAILABLE')
      const value = await response.json()
      if (value.errcode) throw paymentError(`WECHAT_PAYMENT_${value.errcode}`)
      return value
    } catch (error) {
      // Do not expose URLs (access_token), request bodies, keys or platform error text.
      if (error.code?.startsWith('WECHAT_PAYMENT_')) throw error
      throw paymentError('WECHAT_PAYMENT_UNAVAILABLE')
    }
  }

  async token() {
    if (this.cachedToken?.expiresAt > this.now()) return this.cachedToken.value
    if (this.tokenRequest) return this.tokenRequest
    this.tokenRequest = this.post('https://api.weixin.qq.com/cgi-bin/stable_token', JSON.stringify({
      grant_type: 'client_credential', appid: this.config.appId, secret: this.config.appSecret,
      force_refresh: false,
    })).then((result) => {
      if (!result.access_token || !(result.expires_in > 120)) throw paymentError('WECHAT_PAYMENT_TOKEN_INVALID')
      this.cachedToken = { value: result.access_token, expiresAt: this.now() + (result.expires_in - 120) * 1000 }
      return result.access_token
    }).finally(() => { this.tokenRequest = null })
    return this.tokenRequest
  }

  async call(path, payload, signed = true) {
    const body = JSON.stringify(payload)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.token()
      const url = new URL(`https://api.weixin.qq.com${path}`)
      url.searchParams.set('access_token', token)
      if (signed) url.searchParams.set('pay_sig', paySignature(path, body, this.config.appKey))
      try { return await this.post(url, body) } catch (error) {
        if (attempt || !['WECHAT_PAYMENT_40001', 'WECHAT_PAYMENT_40014', 'WECHAT_PAYMENT_42001'].includes(error.code)) throw error
        if (this.cachedToken?.value === token) this.cachedToken = null
      }
    }
  }

  query(order) {
    return this.call('/xpay/query_order', { openid: order.openid, env: order.env, order_id: order.out_trade_no })
  }

  provide(order) {
    return this.call('/xpay/notify_provide_goods', { order_id: order.out_trade_no, env: order.env }, false)
  }

  sign(order, sessionKey) {
    const signData = JSON.stringify({ offerId: order.offer_id, buyQuantity: order.quantity,
      env: order.env, currencyType: order.currency, productId: order.product_id,
      goodsPrice: order.price_fen, outTradeNo: order.out_trade_no, attach: order.attach })
    return { mode: 'short_series_goods', signData,
      paySig: paySignature('requestVirtualPayment', signData, this.config.appKey),
      signature: hmac(sessionKey, signData) }
  }
}

module.exports = { WechatPaymentClient, paySignature, hmac }
