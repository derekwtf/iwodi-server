const { createPublicKey, verify } = require('crypto')
const { APP_PROOF_CLOCK_SKEW_MS, MAX_APP_IDENTITY_PROOF_LIFETIME_MS } = require('../user/app-retention')

const PROVIDERS = {
  apple: { issuers: ['https://appleid.apple.com'], keysUrl: 'https://appleid.apple.com/auth/keys' },
  google: { issuers: ['https://accounts.google.com', 'accounts.google.com'], keysUrl: 'https://www.googleapis.com/oauth2/v3/certs' },
}

function authError(code, message, statusCode = 401) {
  return Object.assign(new Error(message), { code, statusCode })
}

function createAppIdentityVerifier({ appleClientId = '', googleClientId = '', fetchKeys = fetch, now = Date.now } = {}) {
  const audiences = { apple: appleClientId, google: googleClientId }
  const caches = new Map()
  const invalid = () => authError('APP_PROOF_INVALID', '平台登录凭证无效，请重新登录')

  async function getKey(provider, kid) {
    let cache = caches.get(provider)
    if (!cache) {
      cache = { keys: new Map(), expiresAt: 0, refreshedAt: 0, pending: null }
      caches.set(provider, cache)
    }
    if (cache.expiresAt > now() && cache.keys.has(kid)) return cache.keys.get(kid)
    // Unknown key IDs must not turn every invalid login into an upstream request.
    if (!cache.pending && cache.expiresAt > now() && now() - cache.refreshedAt < 60_000) throw invalid()
    if (!cache.pending) {
      cache.pending = (async () => {
        try {
          const response = await fetchKeys(PROVIDERS[provider].keysUrl, { signal: AbortSignal.timeout(5000) })
          if (!response.ok) throw new Error('key fetch failed')
          const body = await response.json()
          if (!Array.isArray(body.keys) || body.keys.length > 20) throw new Error('invalid key set')
          const keys = new Map()
          for (const key of body.keys) {
            if (typeof key.kid !== 'string' || key.kty !== 'RSA' || (key.use && key.use !== 'sig') ||
                (key.alg && key.alg !== 'RS256')) continue
            keys.set(key.kid, createPublicKey({ key, format: 'jwk' }))
          }
          if (!keys.size) throw new Error('empty key set')
          const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/i)?.[1] || 3600)
          cache.keys = keys
          cache.refreshedAt = now()
          cache.expiresAt = now() + Math.min(maxAge, 3600) * 1000
        } catch (_) {
          throw authError('APP_LOGIN_UNAVAILABLE', '平台登录服务暂不可用，请稍后重试', 503)
        } finally { cache.pending = null }
      })()
    }
    await cache.pending
    const key = cache.keys.get(kid)
    if (!key) throw invalid()
    return key
  }

  function requireProvider(provider) {
    if (!Object.hasOwn(PROVIDERS, provider)) throw authError('APP_PROVIDER_INVALID', '请选择 Apple 或 Google 登录', 400)
    if (!audiences[provider]) throw authError('APP_LOGIN_NOT_CONFIGURED', '当前平台登录尚未配置', 503)
  }

  return {
    configured: { apple: Boolean(appleClientId), google: Boolean(googleClientId) },
    requireProvider,
    async verify({ provider, identityToken, nonce }) {
      requireProvider(provider)
      let header, claims, encodedHeader, encodedClaims, signature
      try {
        if (typeof identityToken !== 'string' || identityToken.length > 16_384) throw invalid()
        const segments = identityToken.split('.')
        if (segments.length !== 3 || !segments.every((value) => /^[A-Za-z0-9_-]+$/.test(value))) throw invalid()
        ;[encodedHeader, encodedClaims, signature] = segments
        header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())
        claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString())
        if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 ||
            !claims || !PROVIDERS[provider].issuers.includes(claims.iss) || claims.aud !== audiences[provider] ||
            typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 255 ||
            !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.exp * 1000) || claims.exp * 1000 <= now() ||
            !Number.isSafeInteger(claims.iat) || claims.iat <= 0 || claims.iat * 1000 > now() + APP_PROOF_CLOCK_SKEW_MS || claims.iat >= claims.exp ||
            (claims.exp - claims.iat) * 1000 > MAX_APP_IDENTITY_PROOF_LIFETIME_MS ||
            (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now())) ||
            (provider === 'apple' && (typeof nonce !== 'string' || !nonce || claims.nonce !== nonce))) throw invalid()
      } catch (_) { throw invalid() }
      const key = await getKey(provider, header.kid)
      if (claims.exp * 1000 <= now() ||
          !verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), key, Buffer.from(signature, 'base64url'))) {
        throw invalid()
      }
      // Email, display names and caller-supplied IDs never participate in account ownership.
      return { provider, scope: audiences[provider], subject: claims.sub,
        issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000 }
    },
  }
}

module.exports = { createAppIdentityVerifier, authError }
