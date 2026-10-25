const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const vm = require('node:vm')
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
    assert.match(html, /This page is not available yet/)
    assert.doesNotMatch(html, /mailto:|Effective date|测试运营方/)
    headers(response, html)
  }
  for (const path of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) {
    const response = await get(path)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: { code: 'APP_WEB_NOT_CONFIGURED', message: 'App link association is not configured yet.' } })
    headers(response)
  }
  assert.deepEqual(await (await get('/health')).json(), { status: 'ok' })
  const invite = await get('/join/012345'), html = await invite.text()
  assert.equal(invite.status, 200)
  assert.match(html, /data-room>012345</)
  assert.match(html, /Store downloads are not available yet/)
  assert.doesNotMatch(html, /href="https:/)
})

test('all App pages use the English brand and accessible navigation while preserving operator content', async (t) => {
  const get = await fixture(t)
  for (const path of ['/join/012345', '/support', '/account-deletion', '/privacy', '/terms', '/join/invalid', '/join/%E0%A4%A']) {
    const html = await (await get(path)).text()
    assert.match(html, /<html lang="en">/)
    assert.match(html, /<title>[^<]+ · Who’s Undercover\?<\/title>/)
    assert.match(html, /<div class="brand">Who’s Undercover\?<\/div>/)
    assert.match(html, /href="#content">Skip to content/)
    assert.match(html, /<main id="content" tabindex="-1" aria-labelledby="page-title">/)
    assert.match(html, /<nav aria-label="Support and policies">/)
    assert.doesNotMatch(html.replaceAll(complete.APP_OPERATOR_NAME, ''), /[\u3400-\u9fff]/)
    if (!path.startsWith('/join/')) {
      assert.ok(html.includes(`<a href="${path}" aria-current="page">`))
      assert.ok(html.includes(complete.APP_OPERATOR_NAME))
    }
  }
  const unavailable = await fixture(t, {})
  for (const path of ['/support', '/account-deletion', '/privacy', '/terms']) {
    const html = await (await unavailable(path)).text()
    assert.match(html, /<html lang="en">/)
    assert.match(html, /Who’s Undercover\?/)
    assert.doesNotMatch(html, /[\u3400-\u9fff]/)
  }
})

test('invitation displays only its six-digit room, safe official store links and a nonce-protected clipboard action', async (t) => {
  const get = await fixture(t)
  const response = await get('/join/123456?roomId=%3Csvg%20onload%3Dalert(1)%3E&order=%3Cscript%3Ealert(2)%3C/script%3E')
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /data-room>123456</)
  assert.match(html, /navigator\.clipboard\.writeText\(room\.textContent\)/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /enter the room code manually/)
  assert.match(html, /https:\/\/apps\.apple\.com\/cn\/app\/id123456789/)
  assert.match(html, /details\?id=com\.example\.iwodi&amp;hl=zh/)
  assert.doesNotMatch(html, /onload=|alert\(|<svg|<script>/)
  headers(response, html)
  const next = await get('/join/123456')
  assert.notEqual(next.headers.get('content-security-policy'), response.headers.get('content-security-policy'))
})

test('invitation clipboard copies the exact room and retains a selectable fallback when access is denied', async (t) => {
  const get = await fixture(t)
  const html = await (await get('/join/012345')).text()
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]
  for (const denied of [false, true]) {
    const room = { textContent: '012345' }
    const status = { textContent: '' }
    let click, copied, selected, cleared = false
    const range = { selectNodeContents: (node) => { selected = node } }
    const selection = { removeAllRanges: () => { cleared = true }, addRange: (value) => assert.equal(value, range) }
    vm.runInNewContext(script, {
      document: {
        querySelector: (selector) => ({
          '[data-copy]': { addEventListener: (event, handler) => { assert.equal(event, 'click'); click = handler } },
          '[data-room]': room, '[data-copy-status]': status,
        })[selector],
        createRange: () => range,
      },
      window: { getSelection: () => selection },
      navigator: { clipboard: { writeText: async (text) => {
        if (denied) throw new Error('Permission denied')
        copied = text
      } } },
    })
    await click()
    assert.ok(status.textContent.length > 0)
    assert.doesNotMatch(status.textContent, /[\u3400-\u9fff]/)
    assert.equal(room.textContent, '012345')
    if (denied) {
      assert.match(status.textContent, /selected room code/)
      assert.equal(copied, undefined); assert.equal(selected, room); assert.equal(cleared, true)
    } else {
      assert.equal(status.textContent, 'Room code copied.')
      assert.equal(copied, '012345'); assert.equal(selected, undefined); assert.equal(cleared, false)
    }
  }
})

test('invalid rooms and malformed percent encoding return safe errors without reflecting the input', async (t) => {
  const get = await fixture(t)
  for (const path of ['/join/12345', '/join/1234567', '/join/abc123', '/join/123%2F45', '/join/%3Csvg%20onload%3Dalert(1)%3E']) {
    const response = await get(path), html = await response.text()
    assert.equal(response.status, 404)
    assert.match(html, /Invalid invitation/)
    assert.doesNotMatch(html, /onload=|alert\(|URIError|node_modules/)
    headers(response, html)
  }
  const response = await get('/join/%E0%A4%A'), html = await response.text()
  assert.equal(response.status, 400)
  assert.match(html, /The link is malformed/)
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
  assert.match(html, /nickname reports/)
  assert.match(html, /order ID/)
  assert.match(html, /Do not send login credentials/)
  assert.doesNotMatch(html, /alert\(|attacker|<script/)
  headers(response, html)
  const deletion = await get('/account-deletion'), body = await deletion.text()
  assert.equal(deletion.status, 200)
  assert.match(body, /with the subject “Account deletion request”/)
  assert.match(body, /Sending an email does not mean your account has been deleted/)
  assert.match(body, /Email requests require manual verification/)
  assert.match(body, /Deletion is not an Apple or Google store refund/)
  assert.match(body, /de-identified transaction records and transaction fingerprints are retained for 7 days/)
  assert.match(body, /identity and account fingerprints, together with the deletion time, are also retained for 7 days/)
  assert.match(body, /automatically removed 7 days after account deletion/)
  assert.match(body, /old orders cannot recover the deleted account or transfer its VIP benefits to a new account/)
  assert.match(body, /not fully anonymous/)
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
    assert.match(html, /de-identified transaction records and transaction fingerprints are retained for 7 days/)
    assert.match(html, /for reconciliation, refund checks and prevention of duplicate processing/)
    assert.match(html, /Irreversible identity and account fingerprints, together with the deletion time/)
    assert.match(html, /identity and account fingerprints, together with the deletion time, are also retained for 7 days/)
    assert.match(html, /prevent old platform credentials from recreating the account/)
    assert.match(html, /confirm the outcome of repeated deletion requests/)
    assert.match(html, /not fully anonymous/)
    assert.match(html, /automatically removed 7 days after account deletion/)
    assert.match(html, /old orders cannot recover the deleted account or transfer its VIP benefits to a new account/)
    assert.doesNotMatch(html, /automatic removal is disabled|statutory|compliance complete/)
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
