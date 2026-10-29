const { randomBytes, createHash } = require('crypto')
const { getUserState } = require('../user/profile')
const { authError } = require('./createAppIdentityVerifier')

const CHALLENGE_TTL_MS = 5 * 60 * 1000

function createAppLoginHandler({ roomManager, userStore, tokens, appIdentityVerifier, paymentService,
  appChallenges = new Map(), now = Date.now }) {
  const challenges = appChallenges
  const guestSources = new Map()

  function requireUser(payload, type) {
    const user = userStore.getUser(payload.userId)
    if (!user) throw authError('AUTH_INVALID', '登录已失效，请重新登录')
    userStore.getAppIdentity(user.userId, { allowGuest: true })
    if (type && user.accountType !== type) throw authError('APP_HANDOFF_INVALID', '账号接续身份不匹配')
    return user
  }
  function session(user, { playerId, handoff } = {}) {
    userStore.touchSessionActivity(user.userId, now())
    return { playerId: playerId || roomManager.resolvePlayerIdByIdentity(user.userId),
      ...getUserState(user, paymentService?.product || { priceFen: undefined }), ...tokens.issueApp(user.userId, handoff) }
  }
  function completeHandoff(body) {
    const guestProof = tokens.verifyHandoffGuest(body.guestToken), accountProof = tokens.verify(body.accountToken)
    const account = requireUser(accountProof, 'account')
    const binding = accountProof.handoff
    if (!binding || binding.guestUserId !== guestProof.userId || guestProof.userId === account.userId) {
      throw authError('APP_HANDOFF_INVALID', '账号接续凭证不匹配')
    }
    const guest = userStore.getUser(guestProof.userId)
    if (!guest) {
      // A signed phase-one binding authorizes only this account/guest pair.
      // Returning the formal account's CURRENT state is safe even after receipts
      // expire or the process restarts; never recreate the guest or move a seat.
      const priorSeat = roomManager.sessionRegistry.get(binding.playerId)
      if (priorSeat && priorSeat.identityKey !== account.userId) {
        throw authError('APP_HANDOFF_INVALID', '游客席位已由其他账号接续')
      }
      return session(account)
    }
    if (guest.accountType !== 'guest') throw authError('APP_HANDOFF_INVALID', '仅可接续游客身份')
    roomManager.resolvePlayerIdByIdentity(guest.userId)
    roomManager.preflightIdentityHandoff(guest.userId, account.userId)
    // No await between preflight, durable deletion and memory remapping. A process
    // crash discards all rooms; the signed binding and deletion receipt allow retry.
    userStore.deleteAppUser(guest.userId)
    const playerId = roomManager.handoffIdentity(guest.userId, account.userId)
    return session(account, { playerId })
  }

  return async function handleAppLogin(req, res) {
    try {
      const body = req.body || {}
      if (body.action === 'handoff') return res.json(completeHandoff(body))
      if (body.refreshToken !== undefined) {
        const payload = tokens.verifyRefresh(body.refreshToken)
        return res.json(session(requireUser(payload), { handoff: payload.handoff }))
      }
      const { provider, identityToken, nonce } = body
      if (provider === 'guest') {
        if (typeof body.guestSecret !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.guestSecret)) {
          throw authError('APP_GUEST_SECRET_INVALID', '游客凭证无效', 400)
        }
        for (const [source, bucket] of guestSources) if (bucket.expiresAt <= now()) guestSources.delete(source)
        const source = req.ip || 'unknown'
        const bucket = guestSources.get(source)
        if (bucket?.count >= 60 || (!bucket && guestSources.size >= 1000)) {
          throw authError('APP_LOGIN_RATE_LIMITED', '登录请求过于频繁，请稍后重试', 429)
        }
        guestSources.set(source, { count: (bucket?.count || 0) + 1, expiresAt: bucket?.expiresAt || now() + CHALLENGE_TTL_MS })
        const subject = createHash('sha256').update(body.guestSecret).digest('hex')
        return res.json(session(userStore.findOrCreate({ provider: 'guest', scope: 'app', subject })))
      }
      appIdentityVerifier.requireProvider(provider)
      for (const [key, challenge] of challenges) {
        if (challenge.expiresAt <= now()) challenges.delete(key)
      }
      if (provider === 'apple' && identityToken === undefined) {
        const source = req.ip
        const count = [...challenges.values()].filter((challenge) => challenge.source === source).length
        if (challenges.size >= 1000 || count >= 10) {
          throw authError('APP_LOGIN_RATE_LIMITED', '登录请求过于频繁，请稍后重试', 429)
        }
        const nonce = randomBytes(32).toString('base64url')
        const expiresAt = now() + CHALLENGE_TTL_MS
        challenges.set(nonce, { source, expiresAt })
        return res.json({ nonce, expiresAt })
      }
      if (!identityToken) throw authError('APP_PROOF_REQUIRED', '缺少平台登录凭证', 400)
      const guestProof = body.guestToken ? tokens.verify(body.guestToken) : null
      if (guestProof) requireUser(guestProof, 'guest')
      const challenge = provider === 'apple' ? challenges.get(nonce) : null
      if (provider === 'apple' && !challenge) throw authError('APP_NONCE_INVALID', '登录请求已失效，请重新授权')
      const identity = await appIdentityVerifier.verify({ provider, identityToken, nonce })
      if (provider === 'apple' && (challenge.expiresAt <= now() || !challenges.delete(nonce))) {
        throw authError('APP_NONCE_INVALID', '登录请求已失效，请重新授权')
      }
      // Platform verification awaits network I/O. Never copy or create from a
      // guest that was deleted or handed off while verification was in flight.
      const guest = guestProof ? requireUser(tokens.verify(body.guestToken), 'guest') : null
      const user = userStore.findOrCreate(identity, { initialProfile: guest && { nickname: guest.nickname, avatar: guest.lastNormalAvatar } })
      const preferredPlayerId = typeof body.playerId === 'string' ? body.playerId.trim() || null : null
      const playerId = roomManager.resolvePlayerIdByIdentity(user.userId, preferredPlayerId)
      const handoff = guest ? { guestUserId: guest.userId, playerId: roomManager.resolvePlayerIdByIdentity(guest.userId) } : undefined
      return res.json(session(user, { playerId, handoff }))
    } catch (error) {
      res.status(Number(error?.statusCode) || 502).json({ error: {
        code: error?.code || 'APP_LOGIN_FAILED', message: error?.message || 'App 登录失败',
      } })
    }
  }
}

module.exports = createAppLoginHandler
