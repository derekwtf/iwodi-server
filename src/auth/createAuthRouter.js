const express = require('express')
const createWechatLoginHandler = require('./createWechatLoginHandler')

function createAuthRouter(options) {
  const router = express.Router()
  const handler = createWechatLoginHandler(options)

  router.post('/login', handler)
  router.post(
    '/wechat-login',
    handler
  )

  return router
}

module.exports = createAuthRouter
