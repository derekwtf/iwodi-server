function createWechatLoginHandler({ roomManager, fetchWechatSession, userStore, tokens, appId }) {
  if (!appId) throw new Error('必须配置 WECHAT_APP_ID')
  return async function handleWechatLogin(req, res) {
    const code = String(req.body?.code || '').trim()
    const preferredPlayerId = String(req.body?.playerId || '').trim() || null
    if (!code) {
      res.status(400).json({
        error: {
          code: 'CODE_REQUIRED',
          message: '缺少登录 code',
        },
      })
      return
    }

    try {
      const session = await fetchWechatSession(code)
      const openid = String(session?.openid || '').trim()
      if (!openid) {
        throw createAuthError('OPENID_MISSING', '微信登录未返回 openid', 502)
      }

      const user = userStore.findOrCreate({
        provider: 'wechat_mini_program', scope: appId, subject: openid,
      })
      const playerId = roomManager.resolvePlayerIdByIdentity(
        user.userId,
        preferredPlayerId
      )
      res.json({
        playerId,
        userId: user.userId,
        profile: { nickname: user.nickname, avatar: user.avatar },
        ...tokens.issue(user.userId),
      })
    } catch (error) {
      const status = Number(error?.statusCode) || 502
      res.status(status).json({
        error: {
          code: error?.code || 'WECHAT_LOGIN_FAILED',
          message: error?.message || '微信登录失败',
        },
      })
    }
  }
}

function createAuthError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

module.exports = createWechatLoginHandler
