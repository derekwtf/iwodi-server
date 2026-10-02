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

async function createFixture(filename = ':memory:', options = {}) {
  const userStore = new UserStore(filename)
  const tokens = createTokenService('test-only-secret-'.repeat(4))
  const manager = new RoomManager({ wordLibrary: new WordLibrary(), minStartPlayers: 2 })
  const app = express()
  app.use(express.json())
  // 唯一注入点是既有微信换码函数；生产服务没有测试登录路由。
  app.use('/auth', createAuthRouter({ roomManager: manager, userStore, tokens, appId: options.appId || 'test-app',
    fetchWechatSession: options.fetchWechatSession || (async (code) => ({ openid: `verified-${code}` })) }))
  const server = http.createServer(app)
  const io = new Server(server)
  initializeSocketServer(io, manager, { userStore, tokens })
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
  return { userStore, tokens, manager, app, server, io, url, login, connect,
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

module.exports = { createFixture, request }
