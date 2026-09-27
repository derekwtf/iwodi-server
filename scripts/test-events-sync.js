#!/usr/bin/env node
/**
 * 客户端事件常量与服务端协议兼容性检查（允许服务端保留额外事件）
 * 用法: node server/scripts/test-events-sync.js
 */

const path = require('path')
const fs = require('fs')

const serverEvents = require(path.resolve(__dirname, '../src/socket/events.js'))
const clientEvents = require(path.resolve(__dirname, '../../client/utils/events.js'))

let passed = true

function checkClientEvents(serverObj, clientObj, eventPath = 'EVENTS') {
  for (const key of Object.keys(clientObj).sort()) {
    const currentPath = `${eventPath}.${key}`
    if (!serverObj || !Object.prototype.hasOwnProperty.call(serverObj, key)) {
      console.error(`✗ 客户端有 ${currentPath}，服务端缺失`)
      passed = false
      continue
    }

    const clientValue = clientObj[key]
    const serverValue = serverObj[key]
    if (clientValue && typeof clientValue === 'object' && !Array.isArray(clientValue)) {
      if (!serverValue || typeof serverValue !== 'object' || Array.isArray(serverValue)) {
        console.error(`✗ ${currentPath} 类型不一致`)
        passed = false
      } else {
        checkClientEvents(serverValue, clientValue, currentPath)
      }
    } else if (serverValue !== clientValue) {
      console.error(`✗ ${currentPath} 值不一致: 服务端="${serverValue}" 客户端="${clientValue}"`)
      passed = false
    }
  }
}

checkClientEvents(serverEvents, clientEvents)

for (const fileName of fs.readdirSync(__dirname).filter((name) => name.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(__dirname, fileName), 'utf8')
  for (const match of source.matchAll(/\bEVENTS\.(client|server)\.([A-Z_]+)/g)) {
    const [, namespace, key] = match
    if (!serverEvents[namespace][key]) {
      console.error(`✗ ${fileName} 引用了不存在的事件 EVENTS.${namespace}.${key}`)
      passed = false
    }
  }
}

if (passed) {
  console.log('✓ 客户端声明的事件均与服务端协议一致')
  console.log(`  客户端请求: ${Object.keys(clientEvents.client).length} 个事件`)
  console.log(`  客户端监听: ${Object.keys(clientEvents.server).length} 个事件`)
  process.exit(0)
} else {
  process.exit(1)
}
