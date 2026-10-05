const http = require('http')
const express = require('express')
const { Server } = require('socket.io')
const { io: connectClient } = require('socket.io-client')
const UserStore = require('../src/user/UserStore')
const RoomManager = require('../src/room/RoomManager')
const WordLibrary = require('../src/data/WordLibrary')
const createAuthRouter = require('../src/auth/createAuthRouter')
const { createTokenService } = require('../src/auth/tokens')
const { initializeSocketServer } = require('../src/socket')
const { PaymentService } = require('../src/payment/PaymentService')
const createEventsRouter = require('../src/payment/createEventsRouter')

async function createFixture(filename = ':memory:', options = {}) {
  const userStore = new UserStore(filename)
  const paymentService = options.payment ? new PaymentService({ userStore, ...options.payment }) : null
  const tokens = createTokenService('test-only-secret-'.repeat(4))
  const manager = new RoomManager({ wordLibrary: new WordLibrary() })
  const app = express()
  app.use(express.json())
  // 唯一注入点是既有微信换码函数；生产服务没有测试登录路由。
  app.use('/auth', createAuthRouter({ roomManager: manager, userStore, tokens, paymentService, appId: options.appId || 'test-app',
    fetchWechatSession: options.fetchWechatSession || (async (code) => ({ openid: `verified-${code}` })) }))
  if (paymentService) app.use('/wechat/events', createEventsRouter(paymentService))
  const server = http.createServer(app)
  const io = new Server(server)
  initializeSocketServer(io, manager, { userStore, tokens, paymentService })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const clients = []
  async function login(code, extra = {}, route = 'wechat-login') {
    const res = await fetch(`${url}/auth/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, ...extra }),
    })
    return { status: res.status, ...await res.json() }
  }
  async function connect(auth = {}, options = {}) {
    const socket = connectClient(url, { autoConnect: false, reconnection: false,
      transports: ['websocket'], ...options, auth })
    clients.push(socket)
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timed out')), 2000)
      socket.once('connect:success', (data) => { clearTimeout(timer); resolve(data) })
      socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
    })
    socket.connect()
    return { socket, ...await response }
  }
  return { userStore, paymentService, tokens, manager, app, server, io, url, login, connect,
    async close() {
      clients.forEach((socket) => socket.close())
      for (const roomId of manager.rooms.keys()) manager.destroyRoom(roomId)
      clearInterval(manager.sessionRegistry.sweepTimer)
      await new Promise((resolve) => io.close(resolve))
      if (userStore.db.open) userStore.close()
    },
  }
}

function request(socket, event, data = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), 2000)
    socket.emit(event, data, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
  })
}

async function fillRoom(fixture, roomId) {
  while (fixture.manager.getRoomState(roomId).playerCount < 4) {
    const account = await fixture.login(`extra-${roomId}-${fixture.manager.getRoomState(roomId).playerCount}`)
    const player = await fixture.connect({ token: account.token })
    const joined = await request(player.socket, 'room:join', { roomId })
    if (!joined.ok) throw new Error(joined.error.message)
  }
}

module.exports = { createFixture, request, fillRoom }
