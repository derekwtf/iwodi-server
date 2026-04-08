const assert = require('assert')
const RoomManager = require('../src/room/RoomManager')
const createWechatLoginHandler = require('../src/auth/createWechatLoginHandler')

function createHandler() {
  const roomManager = new RoomManager()
  return createWechatLoginHandler({
    roomManager,
    fetchWechatSession: async (code) => {
      if (code === 'guest-code') {
        return { openid: 'guest-openid' }
      }
      if (code === 'host-code') {
        return { openid: 'host-openid' }
      }
      throw new Error('invalid code')
    },
  })
}

async function invokeHandler(handler, body) {
  let statusCode = 200
  let payload = null
  const res = {
    status(code) {
      statusCode = code
      return this
    },
    json(data) {
      payload = data
      return this
    },
  }

  await handler(
    {
      body,
    },
    res
  )

  return {
    status: statusCode,
    payload,
  }
}

async function testWechatLoginReusesStablePlayerId() {
  const handler = createHandler()
  const first = await invokeHandler(handler, {
    code: 'guest-code',
  })
  const second = await invokeHandler(handler, {
    code: 'guest-code',
  })
  const third = await invokeHandler(handler, {
    code: 'host-code',
  })

  assert.strictEqual(first.status, 200)
  assert.strictEqual(second.status, 200)
  assert.strictEqual(third.status, 200)
  assert.strictEqual(first.payload.playerId, second.payload.playerId)
  assert.notStrictEqual(first.payload.playerId, third.payload.playerId)
}

async function testWechatLoginBindsExistingPlayerIdWhenPreferred() {
  const roomManager = new RoomManager()
  const anonymousPlayerId = roomManager.registerConnection({
    socketId: 'socket-anonymous',
  }).playerId
  const handler = createWechatLoginHandler({
    roomManager,
    fetchWechatSession: async () => ({ openid: 'guest-openid' }),
  })

  const response = await invokeHandler(handler, {
    code: 'guest-code',
    playerId: anonymousPlayerId,
  })
  const repeat = await invokeHandler(handler, {
    code: 'guest-code',
  })

  assert.strictEqual(response.status, 200)
  assert.strictEqual(
    response.payload.playerId,
    anonymousPlayerId,
    '已有 playerId 的老用户应在登录后绑定为同一身份'
  )
  assert.strictEqual(repeat.payload.playerId, anonymousPlayerId)
}

async function testWechatLoginRequiresCode() {
  const handler = createHandler()
  const response = await invokeHandler(handler, {})

  assert.strictEqual(response.status, 400)
  assert.strictEqual(response.payload.error.code, 'CODE_REQUIRED')
}

async function main() {
  await testWechatLoginReusesStablePlayerId()
  await testWechatLoginBindsExistingPlayerIdWhenPreferred()
  await testWechatLoginRequiresCode()
  console.log('WeChat auth route test passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
