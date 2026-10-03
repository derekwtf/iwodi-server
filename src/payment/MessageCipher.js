const { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } = require('crypto')
const { paymentError } = require('./config')

const signature = (...parts) => createHash('sha1').update(parts.map(String).sort().join('')).digest('hex')
function verify(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw paymentError('MESSAGE_INVALID')
}

class MessageCipher {
  constructor({ appId, token, aesKey }) {
    this.appId = appId
    this.token = token
    this.key = Buffer.from(`${aesKey}=`, 'base64')
    if (!token || this.key.length !== 32) throw new Error('消息安全模式配置无效')
  }

  verifyUrl({ signature: value, timestamp, nonce, echostr }) {
    if (![timestamp, nonce, echostr].every((v) => typeof v === 'string' && v.length > 0 && v.length < 2048)) {
      throw paymentError('MESSAGE_INVALID')
    }
    verify(signature(this.token, timestamp, nonce), value)
    return echostr
  }

  decrypt(encrypted, query) {
    if (typeof encrypted !== 'string' || !encrypted || typeof query.timestamp !== 'string' ||
      typeof query.nonce !== 'string' || query.encrypt_type !== 'aes') throw paymentError('MESSAGE_INVALID')
    verify(signature(this.token, query.timestamp, query.nonce, encrypted), query.msg_signature)
    const decipher = createDecipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16))
    decipher.setAutoPadding(false)
    const padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
    const pad = padded.at(-1)
    if (!pad || pad > 32 || !padded.subarray(-pad).every((value) => value === pad)) throw paymentError('MESSAGE_INVALID')
    const raw = padded.subarray(0, -pad)
    if (raw.length < 20) throw paymentError('MESSAGE_INVALID')
    const length = raw.readUInt32BE(16)
    if (20 + length >= raw.length || raw.subarray(20 + length).toString() !== this.appId) throw paymentError('MESSAGE_INVALID')
    return JSON.parse(raw.subarray(20, 20 + length).toString())
  }

  encrypt(value, nonce = randomBytes(8).toString('hex'), timestamp = Math.floor(Date.now() / 1000), random = randomBytes(16)) {
    const message = Buffer.from(JSON.stringify(value))
    const length = Buffer.alloc(4)
    length.writeUInt32BE(message.length)
    const raw = Buffer.concat([random, length, message, Buffer.from(this.appId)])
    const pad = 32 - raw.length % 32
    const cipher = createCipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16))
    cipher.setAutoPadding(false)
    const Encrypt = Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64')
    return { Encrypt, MsgSignature: signature(this.token, timestamp, nonce, Encrypt), TimeStamp: timestamp, Nonce: nonce }
  }
}

module.exports = { MessageCipher, signature }
