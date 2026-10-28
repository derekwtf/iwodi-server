const { createHmac, timingSafeEqual } = require('crypto')

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000

function createTokenService(secret, { now = Date.now } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('AUTH_TOKEN_SECRET 必须配置为至少 32 字节的随机密钥')
  }
  const sign = (body) => createHmac('sha256', secret).update(body).digest('base64url')
  const encode = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${body}.${sign(body)}`
  }
  function verify(token, purpose, { allowExpired = false } = {}) {
    try {
      if (typeof token !== 'string' || token.length > 2048) throw new Error()
      const [body, signature, extra] = token.split('.')
      if (!body || !signature || extra !== undefined) throw new Error()
      const expected = Buffer.from(sign(body)), actual = Buffer.from(signature)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
      // Purpose-less credentials are the existing access token format, never refresh tokens.
      if ((payload.purpose || 'access') !== purpose || typeof payload.userId !== 'string' || !payload.userId ||
          !Number.isSafeInteger(payload.expiresAt) || (!allowExpired && payload.expiresAt <= now())) throw new Error()
      return payload
    } catch (_) {
      throw Object.assign(new Error('登录已失效，请重新登录'), { code: 'AUTH_INVALID', statusCode: 401 })
    }
  }
  return {
    issue(userId) {
      const expiresAt = now() + TOKEN_TTL_MS
      return { token: encode({ userId, expiresAt }), expiresAt }
    },
    issueApp(userId, handoff) {
      const expiresAt = now() + TOKEN_TTL_MS, refreshExpiresAt = now() + REFRESH_TTL_MS
      const binding = handoff ? { handoff } : {}
      return { token: encode({ userId, expiresAt, purpose: 'access', ...binding }), expiresAt,
        refreshToken: encode({ userId, expiresAt: refreshExpiresAt, purpose: 'refresh', ...binding }), refreshExpiresAt }
    },
    verify: (token) => verify(token, 'access'),
    verifyRefresh: (token) => verify(token, 'refresh'),
    // This validates only the old half of an already signed handoff binding.
    // Never use it to authenticate Socket, payment, deletion or refresh.
    verifyHandoffGuest: (token) => verify(token, 'access', { allowExpired: true }),
  }
}

module.exports = { createTokenService, TOKEN_TTL_MS, REFRESH_TTL_MS }
