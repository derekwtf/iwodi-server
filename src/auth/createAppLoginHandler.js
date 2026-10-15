const { randomBytes } = require('crypto')
const { getUserState } = require('../user/profile')
const { authError } = require('./createAppIdentityVerifier')

const CHALLENGE_TTL_MS = 5 * 60 * 1000

function createAppLoginHandler({ roomManager, userStore, tokens, appIdentityVerifier, paymentService,
  appChallenges = new Map(), now = Date.now }) {
  const challenges = appChallenges
  return async function handleAppLogin(req, res) {
    try {
      const { provider, identityToken, nonce } = req.body || {}
      appIdentityVerifier.requireProvider(provider)
      for (const [key, challenge] of challenges) {
        if (challenge.expiresAt <= now()) challenges.delete(key)
      }
      // Expo passes this nonce unchanged to ASAuthorizationAppleIDRequest.
      if (provider === 'apple' && identityToken === undefined) {
        const source = req.ip
        const count = [...challenges.values()].filter((challenge) => challenge.source === source).length
        if (challenges.size >= 1000 || count >= 10) {
          throw authError('APP_LOGIN_RATE_LIMITED', '登录请求过于频繁，请稍后重试', 429)
        }
        const nonce = randomBytes(32).toString('base64url')
        const expiresAt = now() + CHALLENGE_TTL_MS
        challenges.set(nonce, { source, expiresAt })
        res.json({ nonce, expiresAt })
        return
      }
      if (!identityToken) throw authError('APP_PROOF_REQUIRED', '缺少平台登录凭证', 400)
      const challenge = provider === 'apple' ? challenges.get(nonce) : null
      if (provider === 'apple' && !challenge) {
        throw authError('APP_NONCE_INVALID', '登录请求已失效，请重新授权')
      }
      const identity = await appIdentityVerifier.verify({ provider, identityToken, nonce })
      if (provider === 'apple') {
        // Verification awaits network I/O: consume again here to reject concurrent replay.
        if (challenge.expiresAt <= now() || !challenges.delete(nonce)) {
          throw authError('APP_NONCE_INVALID', '登录请求已失效，请重新授权')
        }
      }
      const user = userStore.findOrCreate(identity)
      const preferredPlayerId = typeof req.body.playerId === 'string' ? req.body.playerId.trim() || null : null
      const playerId = roomManager.resolvePlayerIdByIdentity(user.userId, preferredPlayerId)
      res.json({ playerId, ...getUserState(user, paymentService?.product || { priceFen: undefined }), ...tokens.issue(user.userId) })
    } catch (error) {
      res.status(Number(error?.statusCode) || 502).json({ error: {
        code: error?.code || 'APP_LOGIN_FAILED',
        message: error?.message || 'App 登录失败',
      } })
    }
  }
}

module.exports = createAppLoginHandler
