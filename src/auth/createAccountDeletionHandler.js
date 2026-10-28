const { authError } = require('./createAppIdentityVerifier')

function createAccountDeletionHandler({ userStore, tokens, appleRevocationClient, deleteSession,
  appChallenges = new Map(), now = Date.now }) {
  const deleting = new Map()

  function cleanup(userId) {
    if (typeof deleteSession !== 'function') {
      throw authError('APP_DELETE_UNAVAILABLE', '账号删除暂不可用，请稍后重试', 503)
    }
    deleteSession(userId)
  }

  function deletedResult(userId) {
    if (!userStore.isAppUserDeleted(userId)) throw authError('AUTH_INVALID', '登录已失效，请重新登录')
    cleanup(userId)
    return { deleted: true }
  }

  async function remove(userId, body) {
    if (!userStore.getUser(userId)) {
      // A valid old signature can only acknowledge its own completed deletion, never authenticate play.
      return deletedResult(userId)
    }
    if (typeof deleteSession !== 'function') {
      throw authError('APP_DELETE_UNAVAILABLE', '账号删除暂不可用，请稍后重试', 503)
    }
    const identity = userStore.getAppIdentity(userId, { allowGuest: true })
    if (identity.provider === 'apple') {
      if (!appleRevocationClient) throw authError('APPLE_REVOCATION_NOT_CONFIGURED', 'Apple 授权撤销暂未配置，请稍后重试', 503)
      const challenge = appChallenges.get(body.nonce)
      if (!challenge || challenge.expiresAt <= now() || !appChallenges.delete(body.nonce)) {
        throw authError('APP_NONCE_INVALID', '删除请求已失效，请重新进行 Apple 授权')
      }
      // Revocation verifies the exchanged id_token against this DB identity and the one-use nonce.
      const result = await appleRevocationClient.revoke({ authorizationCode: body.authorizationCode,
        nonce: body.nonce, expectedIdentity: identity })
      if (!result?.revoked || ['provider', 'scope', 'subject'].some((key) => result.identity?.[key] !== identity[key])) {
        throw authError('APPLE_REVOCATION_FAILED', 'Apple 授权尚未撤销，请重新授权后重试', 503)
      }
    }
    const result = userStore.deleteAppUser(userId, { expectedIdentity: identity, now: now() })
    // The transaction has committed before synchronous room/socket cleanup. Retry can finish cleanup
    // after an ambiguous response or callback failure without revoking Apple a second time.
    cleanup(userId)
    return result
  }

  return async function deleteAccount(req, res) {
    try {
      const authorization = req.headers?.authorization
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
        throw authError('AUTH_INVALID', '请先登录后再删除账号')
      }
      const { userId } = tokens.verify(authorization.slice(7))
      if (req.body?.statusOnly === true) {
        // Resolve a previous ambiguous request, but never start a new revocation or deletion.
        const pending = deleting.get(userId)
        if (pending) await pending.catch(() => {})
        if (!userStore.getUser(userId)) return res.json(deletedResult(userId))
        userStore.getAppIdentity(userId, { allowGuest: true })
        return res.json({ deleted: false })
      }
      let work = deleting.get(userId)
      if (!work) {
        work = remove(userId, req.body || {})
        deleting.set(userId, work)
      }
      try { res.json(await work) }
      finally { if (deleting.get(userId) === work) deleting.delete(userId) }
    } catch (error) {
      const known = typeof error?.code === 'string'
      res.status(Number(error?.statusCode) || (error?.code === 'AUTH_INVALID' ? 401 : 503)).json({ error: {
        code: known ? error.code : 'APP_DELETE_FAILED',
        message: known ? error.message : '账号删除未完成，请重试确认结果',
      } })
    }
  }
}

module.exports = createAccountDeletionHandler
