function createWechatSessionFetcher({
  appId,
  appSecret,
  timeoutMs = 5000,
} = {}) {
  return async function fetchWechatSession(code) {
    const normalizedCode = String(code || '').trim()
    if (!normalizedCode) {
      throw createAuthError('CODE_REQUIRED', '缺少登录 code', 400)
    }

    if (!appId || !appSecret) {
      throw createAuthError(
        'WECHAT_AUTH_NOT_CONFIGURED',
        '服务端尚未配置微信登录参数',
        503
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
      url.searchParams.set('appid', appId)
      url.searchParams.set('secret', appSecret)
      url.searchParams.set('js_code', normalizedCode)
      url.searchParams.set('grant_type', 'authorization_code')

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      })
      const payload = await response.json()

      if (!response.ok) {
        throw createAuthError(
          'WECHAT_REQUEST_FAILED',
          '微信登录请求失败',
          502
        )
      }

      if (payload.errcode) {
        throw createAuthError(
          'WECHAT_CODE2SESSION_FAILED',
          payload.errmsg || '微信登录失败',
          502
        )
      }

      return {
        openid: payload.openid || '',
        unionid: payload.unionid || '',
        sessionKey: payload.session_key || '',
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw createAuthError('WECHAT_REQUEST_TIMEOUT', '微信登录超时', 504)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function createAuthError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

module.exports = createWechatSessionFetcher
