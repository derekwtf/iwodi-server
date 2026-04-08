const express = require('express')
const createWechatLoginHandler = require('./createWechatLoginHandler')

function createAuthRouter({ roomManager, fetchWechatSession }) {
  const router = express.Router()
  const handler = createWechatLoginHandler({
    roomManager,
    fetchWechatSession,
  })

  router.post('/login', handler)
  router.post(
    '/wechat-login',
    handler
  )

  return router
}

module.exports = createAuthRouter
