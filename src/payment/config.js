const DAY_MS = 24 * 60 * 60 * 1000

function paymentError(code, message = '支付服务暂不可用，请稍后刷新结果') {
  return Object.assign(new Error(message), { code })
}

function readPaymentConfig(env = process.env) {
  const config = {
    enabled: env.VIP_PAYMENT_ENABLED === 'true',
    appId: env.WECHAT_APP_ID || '', appSecret: env.WECHAT_APP_SECRET || '',
    offerId: env.VIP_OFFER_ID || '', appKey: env.VIP_APP_KEY || '',
    productId: env.VIP_PRODUCT_ID || 'vip_month',
    priceFen: Number(env.VIP_PRICE_FEN || 1000), durationDays: 30,
    token: env.WECHAT_MESSAGE_TOKEN || '', aesKey: env.WECHAT_MESSAGE_AES_KEY || '',
  }
  if (config.priceFen !== 1000 || !/^[\w-]{1,64}$/.test(config.productId)) {
    throw new Error('VIP 配置无效：价格须为 1000 分，商品 ID 须有效')
  }
  config.configured = Boolean(config.appId && config.appSecret && config.offerId && config.appKey &&
    config.token && /^[A-Za-z0-9+/]{43}$/.test(config.aesKey))
  if (config.enabled && !config.configured) throw new Error('开启 VIP 售卖前须完整配置支付与消息密钥')
  return config
}

module.exports = { readPaymentConfig, paymentError, DAY_MS }
