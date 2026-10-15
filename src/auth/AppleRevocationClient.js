const { createPrivateKey, sign } = require('crypto')
const { authError } = require('./createAppIdentityVerifier')

const APPLE_AUTH = 'https://appleid.apple.com'
const validString = (value, max = 16_384) => typeof value === 'string' && value.length > 0 && value.length <= max

class AppleRevocationClient {
  constructor({ config = {}, appIdentityVerifier, fetchImpl = fetch, now = Date.now }) {
    this.config = config
    this.appIdentityVerifier = appIdentityVerifier
    this.fetch = fetchImpl
    this.now = now
    this.configured = Boolean(config.teamId && config.keyId && config.privateKey && config.clientId && appIdentityVerifier)
  }

  clientSecret() {
    if (!this.configured) throw authError('APPLE_REVOKE_NOT_CONFIGURED', 'Apple 账号删除尚未配置，请通过支持入口申请', 503)
    try {
      const key = createPrivateKey(this.config.privateKey)
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error()
      const iat = Math.floor(this.now() / 1000)
      const body = [{ alg: 'ES256', kid: this.config.keyId, typ: 'JWT' }, {
        iss: this.config.teamId, sub: this.config.clientId, aud: APPLE_AUTH, iat, exp: iat + 300,
      }].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
      return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
    } catch (_) {
      throw authError('APPLE_REVOKE_NOT_CONFIGURED', 'Apple 账号删除密钥配置无效，请通过支持入口申请', 503)
    }
  }

  async post(path, fields) {
    try {
      return await this.fetch(`${APPLE_AUTH}/auth/${path}`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(10_000), redirect: 'error',
      })
    } catch (_) {
      // A consumed authorization code cannot safely be retried after an ambiguous exchange response.
      throw authError('APPLE_REVOKE_UNAVAILABLE', '未能确认 Apple 授权撤销，请重新授权后重试', 503)
    }
  }

  async revoke({ authorizationCode, nonce, expectedIdentity }) {
    const clientSecret = this.clientSecret()
    if (!validString(authorizationCode, 4096) || !validString(nonce, 256)) {
      throw authError('APPLE_REAUTH_REQUIRED', '请重新使用 Apple 授权后删除账号', 400)
    }
    if (expectedIdentity?.provider !== 'apple' || expectedIdentity.scope !== this.config.clientId ||
        !validString(expectedIdentity.subject, 255)) {
      throw authError('APPLE_IDENTITY_MISMATCH', 'Apple 授权与当前账号不一致', 403)
    }
    const credentials = { client_id: this.config.clientId, client_secret: clientSecret }
    const response = await this.post('token', { ...credentials, grant_type: 'authorization_code', code: authorizationCode })
    let result
    try { result = await response.json() }
    catch (_) { throw authError('APPLE_REVOKE_UNAVAILABLE', 'Apple 授权结果暂不可用，请重新授权后重试', 503) }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw authError('APPLE_REVOKE_UNAVAILABLE', 'Apple 授权结果暂不可用，请重新授权后重试', 503)
    }
    if (!response.ok || result.error) {
      if (result.error === 'invalid_grant') {
        throw authError('APPLE_REAUTH_REQUIRED', 'Apple 授权已过期或已使用，请重新授权', 401)
      }
      throw authError('APPLE_REVOKE_UNAVAILABLE', 'Apple 授权撤销暂不可用，请重新授权后重试', 503)
    }
    const identity = await this.appIdentityVerifier.verify({ provider: 'apple', identityToken: result.id_token, nonce })
    if (identity.provider !== expectedIdentity.provider || identity.scope !== expectedIdentity.scope ||
        identity.subject !== expectedIdentity.subject) {
      throw authError('APPLE_IDENTITY_MISMATCH', 'Apple 授权与当前账号不一致', 403)
    }
    const refresh = validString(result.refresh_token)
    const token = refresh ? result.refresh_token : result.access_token
    if (!validString(token)) throw authError('APPLE_REVOKE_UNAVAILABLE', 'Apple 未返回可撤销的授权，请重新授权后重试', 503)
    const revoked = await this.post('revoke', { ...credentials, token,
      token_type_hint: refresh ? 'refresh_token' : 'access_token' })
    // Apple specifies 200 with an empty body for both successful and already-completed revocation.
    if (revoked.status !== 200) {
      throw authError('APPLE_REVOKE_UNAVAILABLE', '未能确认 Apple 授权撤销，请重新授权后重试', 503)
    }
    let body
    try { body = await revoked.text() }
    catch (_) { throw authError('APPLE_REVOKE_UNAVAILABLE', '未能确认 Apple 授权撤销，请重新授权后重试', 503) }
    if (body.trim()) throw authError('APPLE_REVOKE_UNAVAILABLE', 'Apple 授权撤销响应异常，请重新授权后重试', 503)
    // Never persist or return the code, access token, refresh token, or signed client secret.
    return { revoked: true, identity }
  }
}

module.exports = { AppleRevocationClient }
