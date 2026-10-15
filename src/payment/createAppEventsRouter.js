const express = require('express')

module.exports = function createAppEventsRouter(service) {
  const router = express.Router()
  for (const [route, platform] of [['/apple', 'ios'], ['/google', 'android']]) {
    router.post(route, async (req, res) => {
      try {
        await service.notification(platform, req.body, req.headers)
        res.sendStatus(204)
      } catch (error) {
        // Never include raw proofs, notification bodies or upstream errors in logs/responses.
        service.warn('', error.code || 'APP_NOTIFICATION_FAILED')
        res.sendStatus(error.code === 'PAYMENT_NOTIFICATION_INVALID' ? 403 : 503)
      }
    })
  }
  return router
}
