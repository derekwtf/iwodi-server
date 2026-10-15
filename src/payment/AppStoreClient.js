const { sign } = require('crypto')
const { createAppIdentityVerifier } = require('../auth/createAppIdentityVerifier')
const { verifyAppleSignedData } = require('./AppleSignedData')

const GOOGLE_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'
const GOOGLE_OAUTH = 'https://oauth2.googleapis.com/token'

function storeError(code = 'APP_STORE_PROOF_INVALID', message = '商店交易验证失败', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function jwt(header, payload, privateKey, algorithm) {
  const input = [header, payload].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  const key = algorithm === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : privateKey
  try { return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}` }
  catch (_) { throw storeError('APP_STORE_NOT_CONFIGURED', '商店签名密钥配置无效', 503) }
}

async function responseJson(response) {
  try { return await response.json() }
  catch (_) { throw storeError('APP_STORE_UNAVAILABLE', '商店响应暂不可用，请稍后刷新结果', 503) }
}

function nonempty(value, max = 4096) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max }
function positiveTime(value) { return Number.isSafeInteger(value) && value > 0 }

class AppStoreClient {
  constructor({ config, fetchImpl = fetch, now = Date.now }) {
    this.config = config
    this.fetch = fetchImpl
    this.now = now
    this.googleToken = null
    this.googlePending = null
    this.notificationVerifier = createAppIdentityVerifier({
      googleClientId: config.platforms?.android?.notificationAudience,
      fetchKeys: fetchImpl, now,
    })
  }

  platformConfig(platform) {
    const value = this.config.platforms?.[platform]
    if (!['ios', 'android'].includes(platform) || !value?.appId || !value.storeProductId ||
        !['sandbox', 'production'].includes(value.environment)) {
      throw storeError('APP_STORE_NOT_CONFIGURED', '当前平台商店尚未配置', 503)
    }
    if (platform === 'ios' && (!value.issuerId || !value.keyId || !value.privateKey || !value.rootCertificates?.length) ||
        platform === 'android' && (!value.serviceAccount?.client_email || !value.serviceAccount?.private_key)) {
      throw storeError('APP_STORE_NOT_CONFIGURED', '当前平台商店尚未配置', 503)
    }
    return value
  }

  async response(url, options = {}) {
    try {
      const response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) {
        const error = storeError('APP_STORE_UNAVAILABLE', '商店服务暂不可用，请稍后刷新结果', 503)
        error.upstreamStatus = response.status
        throw error
      }
      return response
    } catch (error) {
      if (error.code === 'APP_STORE_UNAVAILABLE') throw error
      throw storeError('APP_STORE_UNAVAILABLE', '商店服务暂不可用，请稍后刷新结果', 503)
    }
  }

  async googleAccessToken() {
    if (this.googleToken?.expiresAt > this.now() + 60_000) return this.googleToken.value
    if (!this.googlePending) {
      this.googlePending = (async () => {
        const config = this.platformConfig('android')
        const iat = Math.floor(this.now() / 1000)
        const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, {
          iss: config.serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
          aud: GOOGLE_OAUTH, iat, exp: iat + 3600,
        }, config.serviceAccount.private_key, 'RS256')
        const response = await this.response(GOOGLE_OAUTH, { method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        })
        const token = await responseJson(response)
        if (!nonempty(token.access_token) || !Number.isFinite(token.expires_in) || token.expires_in <= 60) {
          throw storeError('APP_STORE_UNAVAILABLE', '商店授权暂不可用', 503)
        }
        this.googleToken = { value: token.access_token, expiresAt: this.now() + Math.min(token.expires_in, 3600) * 1000 }
        return token.access_token
      })().finally(() => { this.googlePending = null })
    }
    return this.googlePending
  }

  async googleRequest(path, method = 'GET', retry = true) {
    const config = this.platformConfig('android')
    const token = await this.googleAccessToken()
    try {
      return await this.response(`${GOOGLE_API}${encodeURIComponent(config.appId)}/${path}`, {
        method, headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    } catch (error) {
      if (retry && error.upstreamStatus === 401) {
        this.googleToken = null
        return this.googleRequest(path, method, false)
      }
      throw error
    }
  }

  checkExpected(input, verified) {
    for (const field of ['environment', 'appId', 'storeProductId', 'transactionId', 'accountToken']) {
      if (input[field] != null && input[field] !== verified[field]) throw storeError()
    }
    return verified
  }

  async verify(input) {
    const config = this.platformConfig(input.platform)
    if (input.platform === 'ios') {
      if (!nonempty(input.transactionId, 128)) throw storeError()
      const iat = Math.floor(this.now() / 1000)
      const token = jwt({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }, {
        iss: config.issuerId, iat, exp: iat + 300, aud: 'appstoreconnect-v1', bid: config.appId,
      }, config.privateKey, 'ES256')
      const host = config.environment === 'sandbox' ? 'api.storekit-sandbox.apple.com' : 'api.storekit.apple.com'
      const response = await this.response(`https://${host}/inApps/v1/transactions/${encodeURIComponent(input.transactionId)}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      const body = await responseJson(response)
      const transaction = verifyAppleSignedData(body.signedTransactionInfo, config.rootCertificates, this.now())
      if (transaction.bundleId !== config.appId || transaction.productId !== config.storeProductId ||
          transaction.environment !== (config.environment === 'sandbox' ? 'Sandbox' : 'Production') ||
          transaction.transactionId !== input.transactionId || transaction.type !== 'Non-Renewing Subscription' ||
          transaction.quantity !== 1 || !nonempty(transaction.appAccountToken, 128) ||
          !positiveTime(transaction.purchaseDate) || transaction.purchaseDate > this.now() + 60_000 ||
          (transaction.revocationDate !== undefined && !positiveTime(transaction.revocationDate))) throw storeError()
      const verified = { platform: 'ios', environment: config.environment, appId: config.appId,
        storeProductId: transaction.productId, transactionId: transaction.transactionId,
        accountToken: transaction.appAccountToken.toLowerCase(), status: transaction.revocationDate ? 'refunded' : 'purchased',
        purchasedAt: transaction.purchaseDate, quantity: 1, finished: false }
      if (transaction.currency !== undefined) {
        if (!/^[A-Z]{3}$/.test(transaction.currency)) throw storeError()
        verified.currency = transaction.currency
      }
      if (transaction.price !== undefined) {
        if (!Number.isSafeInteger(transaction.price) || transaction.price < 0) throw storeError()
        verified.amountMicros = (BigInt(transaction.price) * 1000n).toString()
      }
      if (transaction.revocationDate) {
        verified.refundedAt = transaction.revocationDate
        verified.refundId = `apple:${transaction.transactionId}:${transaction.revocationDate}`
      }
      return this.checkExpected(input, verified)
    }
    if (!nonempty(input.purchaseToken)) throw storeError()
    const response = await this.googleRequest(`purchases/productsv2/tokens/${encodeURIComponent(input.purchaseToken)}`)
    const transaction = await responseJson(response)
    if (!Array.isArray(transaction.productLineItem) || transaction.productLineItem.length !== 1) throw storeError()
    const item = transaction.productLineItem[0]
    const offer = item.productOfferDetails
    const environment = transaction.testPurchaseContext ? 'sandbox' : 'production'
    const state = transaction.purchaseStateContext?.purchaseState
    if (item.productId !== config.storeProductId || environment !== config.environment || offer?.quantity !== 1 ||
        offer.rentOfferDetails || ![undefined, 0, 1].includes(offer.refundableQuantity) ||
        !['PURCHASED', 'PENDING', 'CANCELLED'].includes(state) || !nonempty(transaction.obfuscatedExternalAccountId, 128)) throw storeError()
    const purchasedAt = transaction.purchaseCompletionTime ? Date.parse(transaction.purchaseCompletionTime) : null
    if ((state === 'PURCHASED' && (!positiveTime(purchasedAt) || !nonempty(transaction.orderId, 256))) ||
        (purchasedAt !== null && (!positiveTime(purchasedAt) || purchasedAt > this.now() + 60_000))) throw storeError()
    // A pending purchase may have no order ID yet; the token remains the stable locator.
    const verified = { platform: 'android', environment, appId: config.appId, storeProductId: item.productId,
      transactionId: transaction.orderId || null, purchaseToken: input.purchaseToken,
      accountToken: transaction.obfuscatedExternalAccountId,
      status: state === 'PURCHASED' ? (offer.refundableQuantity === 0 ? 'refunded' : 'purchased')
        : state === 'PENDING' ? 'pending' : 'cancelled',
      purchasedAt, quantity: 1, finished: offer.consumptionState === 'CONSUMPTION_STATE_CONSUMED',
      acknowledged: transaction.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }
    return this.checkExpected(input, verified)
  }

  async complete(verified) {
    this.platformConfig(verified.platform)
    if (verified.platform === 'ios') return { finished: false } // StoreKit finish belongs to the device after durable grant.
    // Requery makes retry after an ambiguous consume response safe and also detects intervening refunds.
    const current = await this.verify(verified)
    if (['refunded', 'cancelled'].includes(current.status)) return { finished: false, verified: current }
    if (current.status !== 'purchased') throw storeError('APP_STORE_NOT_PURCHASED', '交易尚未支付或已撤销')
    if (!current.finished) {
      await this.googleRequest(`purchases/products/${encodeURIComponent(current.storeProductId)}/tokens/${encodeURIComponent(current.purchaseToken)}:consume`, 'POST')
    }
    return { finished: true }
  }

  async verifyNotification(platform, { body, headers = {} }) {
    try {
      const config = this.platformConfig(platform)
      if (platform === 'ios') {
        const notification = verifyAppleSignedData(body?.signedPayload, config.rootCertificates, this.now())
        if (!nonempty(notification.notificationUUID, 128) || notification.version !== '2.0' ||
            notification.data?.bundleId !== config.appId ||
            notification.data?.environment !== (config.environment === 'sandbox' ? 'Sandbox' : 'Production') ||
            (config.environment === 'production' && (!Number.isSafeInteger(config.appAppleId) ||
              notification.data.appAppleId !== config.appAppleId))) throw storeError()
        if (notification.notificationType === 'TEST') return { notificationId: notification.notificationUUID, test: true }
        const transaction = verifyAppleSignedData(notification.data.signedTransactionInfo, config.rootCertificates, this.now())
        if (transaction.bundleId !== config.appId || transaction.environment !== notification.data.environment ||
            transaction.productId !== config.storeProductId || !nonempty(transaction.transactionId, 128)) throw storeError()
        return { notificationId: notification.notificationUUID,
          locator: { platform, transactionId: transaction.transactionId } }
      }
      if (!config.notificationAudience || !config.notificationEmail) throw storeError('APP_STORE_NOT_CONFIGURED', '商店通知尚未配置', 503)
      const authorization = headers.authorization || headers.Authorization
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw storeError()
      const token = authorization.slice(7)
      await this.notificationVerifier.verify({ provider: 'google', identityToken: token })
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))
      if (claims.email_verified !== true || claims.email !== config.notificationEmail) throw storeError()
      if (!nonempty(body?.message?.messageId, 256) || !nonempty(body.message.data, 32_768)) throw storeError()
      const notification = JSON.parse(Buffer.from(body.message.data, 'base64'))
      if (notification.packageName !== config.appId) throw storeError()
      if (notification.testNotification) return { notificationId: body.message.messageId, test: true }
      const purchase = notification.oneTimeProductNotification
      const voided = notification.voidedPurchaseNotification
      if (purchase && voided) throw storeError()
      if (purchase && (!nonempty(purchase.purchaseToken) || purchase.sku !== config.storeProductId || ![1, 2].includes(purchase.notificationType)) ||
          voided && (!nonempty(voided.purchaseToken) || voided.productType !== 2 || ![1, 2].includes(voided.refundType)) ||
          !purchase && !voided) throw storeError()
      return { notificationId: body.message.messageId,
        locator: { platform, purchaseToken: (purchase || voided).purchaseToken } }
    } catch (error) {
      if (error.statusCode === 503) throw error
      throw storeError('PAYMENT_NOTIFICATION_INVALID', '商店通知验证失败', 403)
    }
  }
}

module.exports = { AppStoreClient }
