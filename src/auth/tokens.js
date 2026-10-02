const { createHmac, timingSafeEqual } = require('crypto')

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

function createTokenService(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('AUTH_TOKEN_SECRET 必须配置为至少 32 字节的随机密钥')
  }
  const sign = (body) => createHmac('sha256', secret).update(body).digest('base64url')
  return {
    issue(userId) {
      const expiresAt = Date.now() + TOKEN_TTL_MS
      const body = Buffer.from(JSON.stringify({ userId, expiresAt })).toString('base64url')
      return { token: `${body}.${sign(body)}`, expiresAt }
    },
    verify(token) {
      try {
        if (typeof token !== 'string' || token.length > 1024) throw new Error()
        const [body, signature, extra] = token.split('.')
        if (!body || !signature || extra !== undefined) throw new Error()
        const expected = Buffer.from(sign(body))
        const actual = Buffer.from(signature)
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
        if (typeof payload.userId !== 'string' || !payload.userId ||
          !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) throw new Error()
        return payload
      } catch (_) {
        throw Object.assign(new Error('登录已失效，请重新登录'), { code: 'AUTH_INVALID' })
      }
    },
  }
}

module.exports = { createTokenService, TOKEN_TTL_MS }
