/* eslint-disable no-console */
// 连接验证脚本 — 分别测试 EIO=4 (socket.io-client v4) 和 EIO=3 (模拟 weapp.socket.io) 的连接
const { io } = require('socket.io-client')
const http = require('http')
const EVENTS = require('../src/socket/events')

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://127.0.0.1:3010'

// ─── 工具函数 ───

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler)
      reject(new Error(`等待事件超时: ${eventName}`))
    }, timeoutMs)

    const handler = (payload) => {
      clearTimeout(timer)
      socket.off(eventName, handler)
      resolve(payload)
    }

    socket.on(eventName, handler)
  })
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, data }))
    }).on('error', reject)
  })
}

// ─── 测试 1: EIO=4 标准连接 ───

async function testEIO4() {
  console.log('[测试1] EIO=4 连接...')

  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: {},
  })

  try {
    const connectPromise = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
    socket.connect()
    const payload = await connectPromise
    console.log(`[测试1] EIO=4 连接... ✓ 收到 playerId: ${payload.playerId}`)
    return true
  } catch (err) {
    console.error(`[测试1] EIO=4 连接... ✗ ${err.message}`)
    return false
  } finally {
    socket.close()
  }
}

// ─── 测试 2: EIO=3 polling 握手 ───

async function testEIO3Polling() {
  console.log('[测试2] EIO=3 polling 握手...')

  const url = `${SERVER_URL}/socket.io/?EIO=3&transport=polling`
  try {
    const res = await httpGet(url)
    if (res.status === 200 && res.data) {
      // EIO=3 polling 返回格式: 数字前缀 + JSON，如 "97:0{...}"
      const jsonMatch = res.data.match(/\{.*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.sid) {
          console.log(`[测试2] EIO=3 polling 握手... ✓ 收到 session ID: ${parsed.sid}`)
          return true
        }
      }
      console.error(`[测试2] EIO=3 polling 握手... ✗ 响应无 sid: ${res.data.substring(0, 200)}`)
      return false
    }
    console.error(`[测试2] EIO=3 polling 握手... ✗ HTTP ${res.status}: ${res.data.substring(0, 200)}`)
    return false
  } catch (err) {
    console.error(`[测试2] EIO=3 polling 握手... ✗ ${err.message}`)
    return false
  }
}

// ─── 测试 3: EIO=4 使用 query 传 playerId（模拟客户端方式）───

async function testEIO4WithQuery() {
  console.log('[测试3] EIO=4 + query 方式传 playerId...')

  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket'],
    query: { playerId: '' }, // 空 playerId，模拟首次连接
  })

  try {
    const connectPromise = waitForEvent(socket, EVENTS.server.CONNECT_SUCCESS)
    socket.connect()
    const payload = await connectPromise
    console.log(`[测试3] EIO=4 + query... ✓ 收到 playerId: ${payload.playerId}`)
    return true
  } catch (err) {
    console.error(`[测试3] EIO=4 + query... ✗ ${err.message}`)
    return false
  } finally {
    socket.close()
  }
}

// ─── 测试 4: EIO=3 WebSocket 直连（模拟 weapp.socket.io + transports:['websocket']）───

async function testEIO3WebSocket() {
  console.log('[测试4] EIO=3 WebSocket 直连（模拟 weapp.socket.io 行为）...')

  const WebSocket = require('ws')
  const wsUrl = SERVER_URL.replace('http', 'ws') + '/socket.io/?EIO=3&transport=websocket'

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      console.error('[测试4] EIO=3 WebSocket... ✗ 连接超时(5s)')
      resolve(false)
    }, 5000)

    const messages = []

    ws.on('open', () => {
      console.log('[测试4]   WebSocket 已打开')
    })

    ws.on('message', (data) => {
      const msg = data.toString()
      messages.push(msg)
      console.log('[测试4]   收到:', msg.substring(0, 120))

      // EIO=3 协议: "0" 是 open 包(含 sid)，"40" 是 Socket.IO connect
      // 收到 "40" 后发送 "40" 表示 connect 到默认 namespace
      if (msg === '0') {
        // Engine.IO open 没有 JSON，实际格式是 0{"sid":"...","upgrades":[],...}
      }
      if (msg.startsWith('0{')) {
        // Engine.IO open 包，解析 sid
        try {
          const parsed = JSON.parse(msg.substring(1))
          console.log(`[测试4]   EIO open sid: ${parsed.sid}`)
        } catch (e) { /* ignore */ }
      }

      // 检查是否收到 connect:success 事件
      // Socket.IO v2 格式: 42["event",{data}]
      if (msg.startsWith('42')) {
        try {
          const parsed = JSON.parse(msg.substring(2))
          if (parsed[0] === 'connect:success' && parsed[1]?.playerId) {
            clearTimeout(timer)
            console.log(`[测试4] EIO=3 WebSocket... ✓ 收到 playerId: ${parsed[1].playerId}`)
            ws.close()
            resolve(true)
            return
          }
        } catch (e) { /* ignore */ }
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timer)
      console.error(`[测试4] EIO=3 WebSocket... ✗ ${err.message}`)
      resolve(false)
    })

    ws.on('close', () => {
      clearTimeout(timer)
      if (messages.length === 0) {
        console.error('[测试4] EIO=3 WebSocket... ✗ 连接被关闭，无消息')
        resolve(false)
      }
    })
  })
}

// ─── 主流程 ───

async function main() {
  console.log(`\n目标服务器: ${SERVER_URL}\n`)

  const eio4 = await testEIO4()
  const eio3Polling = await testEIO3Polling()
  const queryMode = await testEIO4WithQuery()
  const eio3Ws = await testEIO3WebSocket()

  console.log('\n─── 总结 ───')
  console.log(`  EIO=4 连接:        ${eio4 ? '✓' : '✗'}`)
  console.log(`  EIO=3 polling:     ${eio3Polling ? '✓' : '✗'}`)
  console.log(`  EIO=4 + query:     ${queryMode ? '✓' : '✗'}`)
  console.log(`  EIO=3 WebSocket:   ${eio3Ws ? '✓' : '✗'}  ← 最接近微信客户端行为`)

  const allPass = eio4 && eio3Polling && queryMode && eio3Ws
  if (allPass) {
    console.log('\n✓ 服务端验证全部通过')
    console.log('  → 问题在微信开发者工具配置或 weapp.socket.io 库本身')
  } else if (eio4 && !eio3Ws) {
    console.log('\n⚠ EIO=4 正常但 EIO=3 WebSocket 失败')
    console.log('  → Socket.IO v4 对 EIO=3 WebSocket 直连兼容可能有问题')
    console.log('  → 考虑升级客户端 socket.io 库或调整 transports 配置')
  }

  console.log('')
  process.exit(allPass ? 0 : 1)
}

main().catch((err) => {
  console.error('脚本异常:', err)
  process.exit(1)
})
