const { readFileSync } = require('fs')

const key = (value = '') => String(value).replace(/\\n/g, '\n')
const field = (value = '') => String(value).trim()

function readAppPaymentConfig(env = process.env) {
  const enabled = env.APP_VIP_PAYMENT_ENABLED === 'true'
  const roots = field(env.APPLE_STORE_ROOT_CERTIFICATES)
  const ios = {
    enabled: enabled && env.APPLE_STORE_ENABLED !== 'false',
    appId: field(env.APPLE_STORE_BUNDLE_ID), storeProductId: field(env.APPLE_STORE_PRODUCT_ID),
    environment: field(env.APPLE_STORE_ENVIRONMENT) || 'sandbox',
    issuerId: field(env.APPLE_STORE_ISSUER_ID), keyId: field(env.APPLE_STORE_KEY_ID),
    privateKey: key(env.APPLE_STORE_PRIVATE_KEY),
    rootCertificates: roots ? roots.split(',').map((path) => readFileSync(path.trim())) : [],
    appAppleId: env.APPLE_STORE_APP_ID ? Number(env.APPLE_STORE_APP_ID) : undefined,
  }
  const android = {
    enabled: enabled && env.GOOGLE_STORE_ENABLED !== 'false',
    appId: field(env.GOOGLE_STORE_PACKAGE_NAME), storeProductId: field(env.GOOGLE_STORE_PRODUCT_ID),
    environment: field(env.GOOGLE_STORE_ENVIRONMENT) || 'sandbox',
    serviceAccount: { client_email: field(env.GOOGLE_STORE_CLIENT_EMAIL), private_key: key(env.GOOGLE_STORE_PRIVATE_KEY) },
    notificationAudience: field(env.GOOGLE_STORE_NOTIFICATION_AUDIENCE),
    notificationEmail: field(env.GOOGLE_STORE_NOTIFICATION_EMAIL),
  }
  for (const [name, platform] of Object.entries({ ios, android })) {
    if (!['sandbox', 'production'].includes(platform.environment)) throw new Error(`${name} 商店环境仅允许 sandbox / production`)
    if (platform.storeProductId && !/^[A-Za-z0-9._-]{1,150}$/.test(platform.storeProductId)) throw new Error(`${name} 商店商品 ID 无效`)
  }
  ios.configured = Boolean(ios.appId && ios.storeProductId && ios.issuerId && ios.keyId && ios.privateKey &&
    ios.rootCertificates.length && (ios.environment !== 'production' || Number.isSafeInteger(ios.appAppleId) && ios.appAppleId > 0))
  android.configured = Boolean(android.appId && android.storeProductId && android.serviceAccount.client_email &&
    android.serviceAccount.private_key && android.notificationAudience && android.notificationEmail)
  for (const [name, platform] of Object.entries({ ios, android })) {
    if (platform.enabled && !platform.configured) throw new Error(`${name} 开放 VIP 售卖前须配置商店验证和通知凭证；暂不开放的平台请显式关闭`)
  }
  return { enabled, configured: ios.configured || android.configured, productId: 'vip_month', durationDays: 30,
    platforms: { ios, android } }
}

module.exports = { readAppPaymentConfig }
