const express = require('express')
const { MessageCipher } = require('./MessageCipher')

module.exports = function createEventsRouter(service) {
  const router = express.Router()
  const cipher = service.config.configured ? new MessageCipher(service.config) : null
  router.get('/', (req, res) => {
    if (!cipher) return res.sendStatus(503)
    try { res.type('text/plain').send(cipher.verifyUrl(req.query)) }
    catch (_) { res.sendStatus(403) }
  })
  router.post('/', async (req, res) => {
    if (!cipher) return res.sendStatus(503)
    let message
    try { message = cipher.decrypt(req.body?.Encrypt, req.query) }
    catch (_) { return res.sendStatus(403) }
    try {
      const result = await service.event(message)
      if (result) res.json(cipher.encrypt(result, req.query.nonce))
      else res.type('text/plain').send('success')
    } catch (error) {
      service.warn(message.OutTradeNo || message.MchOrderId || '', error.code || 'EVENT_FAILED')
      res.status(503).json(cipher.encrypt({ ErrCode: 1, ErrMsg: 'retry' }, req.query.nonce))
    }
  })
  return router
}
