const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const { readAppWebConfig, createAppWebRouter } = require('../src/web/appWeb')

const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':').toUpperCase()
const complete = {
  INVITATION_ORIGIN: 'https://invite.example.test', APP_OPERATOR_NAME: '测试运营方',
  APP_SUPPORT_EMAIL: 'help@example.test',
  APP_POLICY_EFFECTIVE_DATE: '2026-10-14', APP_STORE_URL: 'https://apps.apple.com/cn/app/id123456789',
  GOOGLE_PLAY_URL: 'https://play.google.com/store/apps/details?id=com.example.iwodi&hl=zh',
  APPLE_AUTH_TEAM_ID: 'ABCDE12345', APPLE_CLIENT_ID: 'com.example.iwodi', ANDROID_PACKAGE_NAME: 'com.example.iwodi',
  ANDROID_SHA256_CERT_FINGERPRINTS: fingerprint,
}

async function fixture(t, env = complete) {
  const app = express()
  app.disable('x-powered-by')
  app.use(createAppWebRouter(readAppWebConfig(env)))
  app.get('/health', (req, res) => res.json({ status: 'ok' }))
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  return (path) => fetch(origin + path)
}

function headers(response, html) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const csp = response.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/)
  if (html) {
    const nonce = html.match(/<style nonce="([^"]+)"/)[1]
    assert.ok(csp.includes(`style-src 'nonce-${nonce}'`))
    assert.ok(csp.includes(`script-src 'nonce-${nonce}'`))
    for (const script of html.matchAll(/<script nonce="([^"]+)"/g)) assert.equal(script[1], nonce)
  }
}

test('configuration reuses app identity IDs, requires real public details and reports missing or invalid values', () => {
  const absent = readAppWebConfig({})
  assert.equal(absent.status.policy.configured, false)
  assert.deepEqual(absent.status.policy.missing, ['INVITATION_ORIGIN', 'APP_OPERATOR_NAME', 'APP_SUPPORT_EMAIL', 'APP_POLICY_EFFECTIVE_DATE'])
  assert.equal(absent.retentionDays, 7)
  assert.equal(Object.hasOwn(absent, 'financialRetention'), false)
  assert.equal(Object.hasOwn(absent, 'deletionRetention'), false)
  assert.equal(absent.status.appleAssociation.configured, false)
  assert.equal(absent.status.androidAssociation.configured, false)
  assert.equal(absent.supportEmail, '')
  const config = readAppWebConfig({ ...complete, ANDROID_PACKAGE_NAME: '', GOOGLE_STORE_PACKAGE_NAME: 'com.example.store',
    APPLE_BUNDLE_IDS: 'com.example.one,com.example.two,com.example.one',
    ANDROID_SHA256_CERT_FINGERPRINTS: `${fingerprint.toLowerCase()},${fingerprint}` })
  assert.deepEqual(config.appleBundleIds, ['com.example.one', 'com.example.two'])
  assert.equal(config.androidPackageName, 'com.example.store')
  assert.deepEqual(config.androidFingerprints, [fingerprint])
  assert.equal(config.status.policy.configured, true)
  assert.deepEqual(config.invalid, [])
  assert.equal(readAppWebConfig(complete).appleBundleIds[0], complete.APPLE_CLIENT_ID)
  const invalid = readAppWebConfig({ ...complete, INVITATION_ORIGIN: 'https://user:secret@example.test',
    APP_SUPPORT_EMAIL: 'help@example.test\r\nBcc:attacker@example.test', APP_POLICY_EFFECTIVE_DATE: '2026-02-30',
    APPLE_AUTH_TEAM_ID: 'wrong', APPLE_BUNDLE_IDS: 'good.bundle,bad*', ANDROID_SHA256_CERT_FINGERPRINTS: 'AA:BB' })
  assert.deepEqual(invalid.invalid.sort(), ['INVITATION_ORIGIN', 'APP_SUPPORT_EMAIL', 'APP_POLICY_EFFECTIVE_DATE',
    'APPLE_AUTH_TEAM_ID', 'APPLE_BUNDLE_IDS', 'ANDROID_SHA256_CERT_FINGERPRINTS'].sort())
  assert.equal(invalid.status.policy.configured, false)
  assert.equal(invalid.status.appleAssociation.configured, false)
})

test('unconfigured websites publish neither contacts nor policies nor associated-domain identities; game health remains available', async (t) => {
  const get = await fixture(t, {})
  for (const path of ['/support', '/account-deletion', '/privacy', '/terms']) {
    const response = await get(path), html = await response.text()
    assert.equal(response.status, 503)
    assert.match(html, /尚未配置完成/)
    assert.doesNotMatch(html, /mailto:|生效日期|测试运营方/)
    headers(response, html)
  }
  for (const path of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) {
    const response = await get(path)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: { code: 'APP_WEB_NOT_CONFIGURED', message: '应用链接关联尚未配置完成' } })
    headers(response)
  }
  assert.deepEqual(await (await get('/health')).json(), { status: 'ok' })
  const invite = await get('/join/012345'), html = await invite.text()
  assert.equal(invite.status, 200)
  assert.match(html, /data-room>012345</)
  assert.match(html, /商店下载入口尚未提供/)
  assert.doesNotMatch(html, /href="https:/)
})

test('invitation displays only its six-digit room, safe official store links and a nonce-protected clipboard action', async (t) => {
  const get = await fixture(t)
  const response = await get('/join/123456?roomId=%3Csvg%20onload%3Dalert(1)%3E&order=%3Cscript%3Ealert(2)%3C/script%3E')
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /data-room>123456</)
  assert.match(html, /navigator\.clipboard\.writeText\(room\.textContent\)/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /请手动输入房间号/)
  assert.match(html, /https:\/\/apps\.apple\.com\/cn\/app\/id123456789/)
  assert.match(html, /details\?id=com\.example\.iwodi&amp;hl=zh/)
  assert.doesNotMatch(html, /onload=|alert\(|<svg|<script>/)
  headers(response, html)
  const next = await get('/join/123456')
  assert.notEqual(next.headers.get('content-security-policy'), response.headers.get('content-security-policy'))
})

test('invalid rooms and malformed percent encoding return safe errors without reflecting the input', async (t) => {
  const get = await fixture(t)
  for (const path of ['/join/12345', '/join/1234567', '/join/abc123', '/join/123%2F45', '/join/%3Csvg%20onload%3Dalert(1)%3E']) {
    const response = await get(path), html = await response.text()
    assert.equal(response.status, 404)
    assert.match(html, /邀请链接无效/)
    assert.doesNotMatch(html, /onload=|alert\(|URIError|node_modules/)
    headers(response, html)
  }
  const response = await get('/join/%E0%A4%A'), html = await response.text()
  assert.equal(response.status, 400)
  assert.match(html, /链接格式不正确/)
  assert.doesNotMatch(html, /URIError|node_modules/)
  headers(response, html)
})

test('unsafe origins, contacts and store URLs never become executable links', async (t) => {
  for (const value of ['http://example.test', 'https://example.test/path', 'https://example.test?redirect=other', 'https://example.test/#fragment']) {
    assert.equal(readAppWebConfig({ INVITATION_ORIGIN: value }).origin, '')
  }
  const get = await fixture(t, { ...complete, APP_STORE_URL: 'javascript:alert(1)', GOOGLE_PLAY_URL: 'https://play.google.com.evil.test/store/apps/details?id=com.example.app', APP_SUPPORT_EMAIL: '\" onclick=\"alert(1)@example.test' })
  const response = await get('/join/123456'), html = await response.text()
  assert.doesNotMatch(html, /javascript:|evil\.test|onclick=|alert\(/)
  assert.equal((await get('/support')).status, 503)
})

test('support and deletion explain reporting, safe order references and the manual request boundary', async (t) => {
  const get = await fixture(t)
  const response = await get('/support?order=%3Cscript%3Ealert(1)%3C%2Fscript%3E&email=attacker%40evil.test')
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /mailto:help@example\.test/)
  assert.match(html, /昵称举报/)
  assert.match(html, /业务订单号/)
  assert.match(html, /不要发送登录凭证/)
  assert.doesNotMatch(html, /alert\(|attacker|<script/)
  headers(response, html)
  const deletion = await get('/account-deletion'), body = await deletion.text()
  assert.equal(deletion.status, 200)
  assert.match(body, /发送主题为「账号删除申请」/)
  assert.match(body, /发送邮件不代表账号已经删除/)
  assert.match(body, /网页邮件申请需要人工核验/)
  assert.match(body, /删除不等于 Apple 或 Google 商店退款/)
  assert.match(body, /去标识交易记录及交易指纹保留 7 天/)
  assert.match(body, /身份和账号指纹以及删除时间同样保留 7 天/)
  assert.match(body, /账号删除 7 天后自动清理/)
  assert.match(body, /无法再凭旧订单找回已删除账号或向新账号认领原有 VIP 权益/)
  assert.match(body, /不属于完全匿名数据/)
})

test('policies bind both record types to the implemented seven-day retention and ignore obsolete free-text overrides', async (t) => {
  const get = await fixture(t, { ...complete, APP_OPERATOR_NAME: '<img src=x onerror=alert(1)> & 运营方',
    APP_FINANCIAL_RETENTION: '规则：<script>alert(2)</script>，需人工核对。',
    APP_DELETION_RETENTION: '删除说明：<svg onload=alert(3)>，与财务记录分别处理。' })
  for (const path of ['/privacy', '/terms']) {
    const response = await get(path), html = await response.text()
    assert.equal(response.status, 200)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; 运营方/)
    assert.doesNotMatch(html, /<img|<script|<svg/)
    assert.match(html, /2026-10-14/)
    headers(response, html)
    assert.doesNotMatch(html, /alert\(2\)|alert\(3\)|需人工核对|与财务记录分别处理/)
    assert.match(html, /去标识交易记录及交易指纹保留 7 天/)
    assert.match(html, /用于对账、退款核对和防止重复处理/)
    assert.match(html, /不可逆的身份和账号指纹以及删除时间/)
    assert.match(html, /身份和账号指纹以及删除时间同样保留 7 天/)
    assert.match(html, /拒绝删除前的旧平台证明重建账号/)
    assert.match(html, /确认重复删除请求的结果/)
    assert.match(html, /不属于完全匿名数据/)
    assert.match(html, /账号删除 7 天后自动清理/)
    assert.match(html, /无法再凭旧订单找回已删除账号或向新账号认领原有 VIP 权益/)
    assert.doesNotMatch(html, /未启用自动清理|法定|合规已完成/)
  }
  for (const key of ['INVITATION_ORIGIN', 'APP_OPERATOR_NAME', 'APP_SUPPORT_EMAIL', 'APP_POLICY_EFFECTIVE_DATE']) {
    const env = { ...complete, [key]: '' }
    assert.deepEqual(readAppWebConfig(env).status.policy, { configured: false, missing: [key] })
    const missing = await fixture(t, env)
    assert.equal((await missing('/privacy')).status, 503)
    assert.equal((await missing('/terms')).status, 503)
  }
  const noFreeText = await fixture(t, { ...complete, APP_FINANCIAL_RETENTION: '', APP_DELETION_RETENTION: '' })
  assert.equal((await noFreeText('/privacy')).status, 200)
  assert.equal((await noFreeText('/terms')).status, 200)
})

test('association files contain only configured exact app IDs, package names and certificate fingerprints', async (t) => {
  const get = await fixture(t, { ...complete, APPLE_BUNDLE_IDS: 'com.example.ios,com.example.ios.test' })
  const apple = await get('/.well-known/apple-app-site-association')
  assert.equal(apple.status, 200)
  assert.match(apple.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await apple.json(), { applinks: { apps: [], details: [
    { appID: 'ABCDE12345.com.example.ios', paths: ['/join/??????'] },
    { appID: 'ABCDE12345.com.example.ios.test', paths: ['/join/??????'] },
  ] } })
  const android = await get('/.well-known/assetlinks.json')
  assert.equal(android.status, 200)
  assert.deepEqual(await android.json(), [{ relation: ['delegate_permission/common.handle_all_urls'], target: {
    namespace: 'android_app', package_name: 'com.example.iwodi', sha256_cert_fingerprints: [fingerprint],
  } }])
  headers(apple)
  headers(android)
  const incomplete = await fixture(t, { ...complete, APPLE_AUTH_TEAM_ID: '', ANDROID_SHA256_CERT_FINGERPRINTS: '00:11' })
  assert.equal((await incomplete('/.well-known/apple-app-site-association')).status, 503)
  assert.equal((await incomplete('/.well-known/assetlinks.json')).status, 503)
})
