// 使用实际 weapp.socket.io 发布包和微信 WebSocket 适配器验证 auth 协议。
const assert = require('assert/strict')
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const WebSocket = require('ws')
const { createFixture, request } = require('./auth-fixture')

function loadWeappClient() {
  const urls = []
  const wx = {
    connectSocket({ url }) {
      urls.push(url)
      const ws = new WebSocket(url)
      return {
        onOpen(fn) { ws.on('open', fn) },
        onMessage(fn) { ws.on('message', (data) => fn({ data: data.toString() })) },
        onError(fn) { ws.on('error', (error) => fn({ errMsg: error.message })) },
        onClose(fn) { ws.on('close', (code, reason) => fn({ code, reason: reason.toString() })) },
        send({ data }) { ws.send(data) },
        close({ code, reason }) { ws.close(code, reason) },
      }
    },
  }
  const context = vm.createContext({ wx, console, setTimeout, clearTimeout, Date,
    ArrayBuffer, Uint8Array, Buffer, module: { exports: {} } })
  context.window = context
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../client/utils/wx-websocket.js'), 'utf8'), context)
  context.WebSocket = context.module.exports
  context.module = { exports: {} }
  context.exports = context.module.exports
  const bundle = process.env.WEAPP_BUNDLE_PATH || path.join(__dirname, '../../client/node_modules/weapp.socket.io/lib/weapp.socket.io.js')
  vm.runInContext(fs.readFileSync(bundle, 'utf8'), context)
  return { io: context.module.exports, urls }
}

async function main() {
  const f = await createFixture()
  let socket
  try {
    const login = await f.login('weapp')
    const client = loadWeappClient()
    assert.equal(client.io.protocol, 5)
    socket = client.io(f.url, { autoConnect: false, transports: ['websocket'], reconnection: false,
      auth: { token: login.token, playerId: login.playerId } })
    const connected = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('weapp handshake timeout')), 2000)
      socket.on('connect:success', (data) => { clearTimeout(timeout); resolve(data) })
      socket.on('connect_error', (error) => { clearTimeout(timeout); reject(error) })
    })
    socket.connect()
    const data = await connected
    assert.equal(data.userId, login.userId)
    assert.equal(data.profile.avatar, login.profile.avatar)
    assert.ok(client.urls.every((url) => url.includes('EIO=4') && !url.includes(login.token) && !url.includes('playerId')))
    assert.equal((await request(socket, 'room:create')).ok, true)
    console.log('Weapp bundle + wx adapter: EIO=4 authenticated handshake passed.')
  } finally { if (socket) socket.close(); await f.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
