#!/usr/bin/env node
/**
 * 前后端事件常量一致性检查
 * 用法: node server/scripts/test-events-sync.js
 */

const path = require('path')

const serverEvents = require(path.resolve(__dirname, '../src/socket/events.js'))
const clientEvents = require(path.resolve(__dirname, '../../client/utils/events.js'))

let passed = true

function deepCompare(serverObj, clientObj, path = '') {
  const serverKeys = Object.keys(serverObj).sort()
  const clientKeys = Object.keys(clientObj).sort()

  // 检查 server 有但 client 没有的
  for (const key of serverKeys) {
    if (!(key in clientObj)) {
      console.error(`✗ 服务端有 ${path}.${key}，客户端缺失`)
      passed = false
      continue
    }
    if (typeof serverObj[key] === 'object' && serverObj[key] !== null) {
      deepCompare(serverObj[key], clientObj[key], `${path}.${key}`)
    } else if (serverObj[key] !== clientObj[key]) {
      console.error(`✗ ${path}.${key} 值不一致: 服务端="${serverObj[key]}" 客户端="${clientObj[key]}"`)
      passed = false
    }
  }

  // 检查 client 有但 server 没有的
  for (const key of clientKeys) {
    if (!(key in serverObj)) {
      console.error(`✗ 客户端有 ${path}.${key}，服务端缺失`)
      passed = false
    }
  }
}

deepCompare(serverEvents, clientEvents, 'EVENTS')

if (passed) {
  console.log('✓ 前后端事件常量完全一致')
  console.log(`  client: ${Object.keys(clientEvents.client).length} 个事件`)
  console.log(`  server: ${Object.keys(clientEvents.server).length} 个事件`)
  process.exit(0)
} else {
  process.exit(1)
}
