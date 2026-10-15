const express = require('express')
const createWechatLoginHandler = require('./createWechatLoginHandler')
const createAppLoginHandler = require('./createAppLoginHandler')
const createAccountDeletionHandler = require('./createAccountDeletionHandler')

function createAuthRouter(options) {
  const router = express.Router()
  if (options.channel === 'app') {
    const appOptions = { ...options, appChallenges: new Map() }
    router.post('/app-login', createAppLoginHandler(appOptions))
    router.delete('/account', createAccountDeletionHandler(appOptions))
    return router
  }
  const handler = createWechatLoginHandler(options)

  router.post('/login', handler)
  router.post(
    '/wechat-login',
    handler
  )

  return router
}

module.exports = createAuthRouter
