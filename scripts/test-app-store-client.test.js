const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { generateKeyPairSync, sign, verify, X509Certificate } = require('node:crypto')
const { AppStoreClient } = require('../src/payment/AppStoreClient')
const { verifyAppleSignedData } = require('../src/payment/AppleSignedData')

const dir = mkdtempSync(join(tmpdir(), 'iwodi-store-certs-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))
const now = Date.now()
const accountToken = '9a2ab112-d399-4400-b000-baf339b447af'
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })

function openssl(args) {
  const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

function certificate(name, issuer, extension) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  writeFileSync(join(dir, `${name}.key`), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  writeFileSync(join(dir, `${name}.cnf`), `[req]\ndistinguished_name=dn\n[dn]\n[ext]\n${extension}\n`)
  if (!issuer) {
    openssl(['req', '-new', '-x509', '-key', `${name}.key`, '-out', `${name}.pem`, '-days', '2',
      '-subj', `/CN=${name}`, '-config', `${name}.cnf`, '-extensions', 'ext'])
  } else {
    openssl(['req', '-new', '-key', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`, '-config', `${name}.cnf`])
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`,
      '-CAcreateserial', '-days', '2', '-out', `${name}.pem`, '-extfile', `${name}.cnf`, '-extensions', 'ext'])
  }
  return { ...pair, pem: readFileSync(join(dir, `${name}.pem`)),
    der: new X509Certificate(readFileSync(join(dir, `${name}.pem`))).raw.toString('base64') }
}

const root = certificate('test-root', null, 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign')
const intermediate = certificate('test-intermediate', 'test-root',
  'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=DER:05:00')
const leaf = certificate('test-leaf', 'test-intermediate',
  'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=DER:05:00')
const unrelatedLeaf = certificate('unrelated-leaf', 'test-intermediate', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature')

function appleJws(payload, options = {}) {
  const signer = options.leaf || leaf
  const input = [{ alg: 'ES256', x5c: [signer.der, intermediate.der, root.der], ...options.header },
    { signedDate: now, ...payload }].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${input}.${sign('sha256', Buffer.from(input), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

function appleTransaction(overrides = {}) {
  return { transactionId: '10000001', bundleId: 'com.test.app', productId: 'vip.30.days', environment: 'Sandbox',
    appAccountToken: accountToken, type: 'Non-Renewing Subscription', quantity: 1, purchaseDate: now - 10_000,
    currency: 'USD', price: 1990, ...overrides }
}

function googleTransaction(overrides = {}) {
  return { productLineItem: [{ productId: 'vip.30.days', productOfferDetails: { quantity: 1,
    refundableQuantity: 1, consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED' } }],
    purchaseStateContext: { purchaseState: 'PURCHASED' }, testPurchaseContext: { fopType: 'TEST' },
    orderId: 'GPA.1234-5678', obfuscatedExternalAccountId: accountToken,
    purchaseCompletionTime: new Date(now - 10_000).toISOString(), acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', ...overrides }
}

function config() {
  return { platforms: {
    ios: { appId: 'com.test.app', storeProductId: 'vip.30.days', environment: 'sandbox', issuerId: 'issuer', keyId: 'key-id',
      privateKey: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }), rootCertificates: [root.pem], appAppleId: 123456 },
    android: { appId: 'com.test.app', storeProductId: 'vip.30.days', environment: 'sandbox',
      serviceAccount: { client_email: 'billing@test.iam.gserviceaccount.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
      notificationAudience: 'https://app.example.com/payments/google', notificationEmail: 'push@test.iam.gserviceaccount.com' },
  } }
}

function json(body, status = 200) { return new Response(JSON.stringify(body), { status }) }

test('Apple JWS requires trusted chain, Apple purpose extensions, date and real ES256 signature', () => {
  const valid = appleJws(appleTransaction())
  assert.equal(verifyAppleSignedData(valid, [root.pem], now).transactionId, '10000001')
  for (const candidate of [valid + 'x', appleJws(appleTransaction(), { header: { alg: 'HS256' } }),
    appleJws(appleTransaction(), { header: { x5c: [leaf.der, root.der] } }),
    appleJws(appleTransaction(), { leaf: unrelatedLeaf }),
    appleJws({ ...appleTransaction(), signedDate: now + 120_000 }),
    appleJws({ ...appleTransaction(), signedDate: now - 10 * 86400000 }), 'bad']) {
    assert.throws(() => verifyAppleSignedData(candidate, [root.pem], now), { code: 'APP_STORE_PROOF_INVALID' })
  }
  assert.throws(() => verifyAppleSignedData(valid, [intermediate.pem], now), { code: 'APP_STORE_PROOF_INVALID' })
})

test('Apple REST signs a 5 minute API JWT and verifies app, SKU, environment, owner, type and amount', async () => {
  let transaction = appleTransaction()
  const client = new AppStoreClient({ config: config(), now: () => now, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.storekit-sandbox.apple.com/inApps/v1/transactions/10000001')
    const [header, body, signature] = options.headers.authorization.slice(7).split('.')
    assert.equal(verify('sha256', Buffer.from(`${header}.${body}`),
      { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true)
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'key-id', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(body, 'base64url'))
    assert.equal(claims.exp - claims.iat, 300)
    assert.equal(claims.aud, 'appstoreconnect-v1')
    assert.equal(claims.bid, 'com.test.app')
    return json({ signedTransactionInfo: appleJws(transaction) })
  } })
  const input = { platform: 'ios', transactionId: '10000001', accountToken }
  const verified = await client.verify(input)
  assert.equal(verified.status, 'purchased')
  assert.equal(verified.amountMicros, '1990000')
  assert.equal(verified.currency, 'USD')
  assert.deepEqual(await client.complete(verified), { finished: false })
  transaction = appleTransaction({ revocationDate: now - 1000 })
  assert.equal((await client.verify(input)).status, 'refunded')
  for (const changed of [{ bundleId: 'wrong' }, { productId: 'wrong' }, { environment: 'Production' },
    { transactionId: 'wrong' }, { appAccountToken: 'other-account' }, { appAccountToken: undefined },
    { type: 'Auto-Renewable Subscription' }, { quantity: 2 }, { price: 1.1 }, { purchaseDate: now + 120_000 }]) {
    transaction = appleTransaction(changed)
    await assert.rejects(client.verify(input), { code: 'APP_STORE_PROOF_INVALID' })
  }
})

test('Google OAuth signs RS256, coalesces token refresh and verifies purchase/account/product/environment', async () => {
  let oauthCalls = 0, transaction = googleTransaction()
  const client = new AppStoreClient({ config: config(), now: () => now, fetchImpl: async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls += 1
      const form = new URLSearchParams(options.body)
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      const [header, body, signature] = form.get('assertion').split('.')
      assert.equal(verify('sha256', Buffer.from(`${header}.${body}`), rsa.publicKey, Buffer.from(signature, 'base64url')), true)
      const claims = JSON.parse(Buffer.from(body, 'base64url'))
      assert.equal(claims.aud, url)
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher')
      assert.equal(claims.iss, 'billing@test.iam.gserviceaccount.com')
      return json({ access_token: 'server-access-token', expires_in: 3600 })
    }
    assert.equal(url, 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.test.app/purchases/productsv2/tokens/purchase-token')
    assert.equal(options.headers.authorization, 'Bearer server-access-token')
    return json(transaction)
  } })
  const input = { platform: 'android', purchaseToken: 'purchase-token', accountToken }
  const values = await Promise.all([client.verify(input), client.verify(input)])
  assert.equal(oauthCalls, 1)
  assert.equal(values[0].status, 'purchased')
  assert.equal(values[0].amountMicros, undefined)
  assert.equal(values[0].transactionId, 'GPA.1234-5678')
  transaction = googleTransaction({ purchaseStateContext: { purchaseState: 'PENDING' }, orderId: undefined, purchaseCompletionTime: undefined })
  assert.equal((await client.verify(input)).status, 'pending')
  transaction = googleTransaction({ purchaseStateContext: { purchaseState: 'CANCELLED' } })
  assert.equal((await client.verify(input)).status, 'cancelled')
  transaction = googleTransaction()
  transaction.productLineItem[0].productOfferDetails.refundableQuantity = 0
  assert.equal((await client.verify(input)).status, 'refunded')
  for (const changed of [{ productLineItem: [] }, { testPurchaseContext: undefined }, { obfuscatedExternalAccountId: 'other' },
    { obfuscatedExternalAccountId: undefined }, { purchaseStateContext: { purchaseState: 'UNKNOWN' } },
    { purchaseCompletionTime: undefined }, { orderId: undefined },
    { productLineItem: [{ productId: 'wrong', productOfferDetails: { quantity: 1 } }] },
    { productLineItem: [{ productId: 'vip.30.days', productOfferDetails: { quantity: 2 } }] }]) {
    transaction = googleTransaction(changed)
    await assert.rejects(client.verify(input), { code: 'APP_STORE_PROOF_INVALID' })
  }
})

test('Google completion retries only after durable grant, and ambiguous consume results requery before repeating', async () => {
  let consumed = false, consumeCalls = 0, refunded = false
  const client = new AppStoreClient({ config: config(), now: () => now, fetchImpl: async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'token', expires_in: 3600 })
    if (url.endsWith(':consume')) {
      consumeCalls += 1
      if (consumeCalls === 1) return json({}, 503)
      consumed = true
      throw new Error('response lost after successful consumption')
    }
    const transaction = googleTransaction()
    if (consumed) transaction.productLineItem[0].productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED'
    if (refunded) transaction.productLineItem[0].productOfferDetails.refundableQuantity = 0
    return json(transaction)
  } })
  const verified = await client.verify({ platform: 'android', purchaseToken: 'purchase-token', accountToken })
  assert.equal(consumeCalls, 0)
  await assert.rejects(client.complete(verified), { code: 'APP_STORE_UNAVAILABLE' })
  await assert.rejects(client.complete(verified), { code: 'APP_STORE_UNAVAILABLE' })
  assert.deepEqual(await client.complete(verified), { finished: true })
  assert.equal(consumeCalls, 2)
  refunded = true
  const cancelled = await client.complete(verified)
  assert.equal(cancelled.finished, false)
  assert.equal(cancelled.verified.status, 'refunded')
  assert.equal(consumeCalls, 2)
})

test('Apple notification validates both signed envelopes and app scope before returning a locator', async () => {
  const client = new AppStoreClient({ config: config(), now: () => now })
  const payload = { notificationUUID: 'notification-1', notificationType: 'REFUND', version: '2.0',
    data: { bundleId: 'com.test.app', environment: 'Sandbox', signedTransactionInfo: appleJws(appleTransaction()) } }
  const result = await client.verifyNotification('ios', { body: { signedPayload: appleJws(payload) } })
  assert.deepEqual(result, { notificationId: 'notification-1', notificationType: 'REFUND', signedDate: now,
    locator: { platform: 'ios', transactionId: '10000001', environment: 'sandbox', appId: 'com.test.app',
      storeProductId: 'vip.30.days', accountToken } })
  assert.equal(result.status, undefined)
  for (const changed of [{ ...payload, data: { ...payload.data, bundleId: 'wrong' } },
    { ...payload, data: { ...payload.data, signedTransactionInfo: 'fake' } },
    { ...payload, data: { ...payload.data, environment: 'Production' } }]) {
    await assert.rejects(client.verifyNotification('ios', { body: { signedPayload: appleJws(changed) } }),
      { code: 'PAYMENT_NOTIFICATION_INVALID', statusCode: 403 })
  }
})

test('Apple refund reversal retains only signed event metadata and rechecks transaction ownership', async () => {
  let current = appleTransaction(), queries = 0
  const client = new AppStoreClient({ config: config(), now: () => now, fetchImpl: async (url) => {
    queries += 1
    assert.equal(url, 'https://api.storekit-sandbox.apple.com/inApps/v1/transactions/10000001')
    return json({ signedTransactionInfo: appleJws(current) })
  } })
  const payload = { notificationUUID: 'reversal-1', notificationType: 'REFUND_REVERSED', signedDate: now - 1000,
    version: '2.0', data: { bundleId: 'com.test.app', environment: 'Sandbox',
      signedTransactionInfo: appleJws(appleTransaction({ appAccountToken: accountToken.toUpperCase() })) } }
  const notification = await client.verifyNotification('ios', { body: { signedPayload: appleJws(payload),
    notificationType: 'REFUND', signedDate: now + 1000 } })
  assert.equal(notification.notificationType, 'REFUND_REVERSED')
  assert.equal(notification.signedDate, now - 1000)
  assert.equal(notification.status, undefined)
  assert.equal(queries, 0)
  assert.equal((await client.verify(notification.locator)).status, 'purchased')
  assert.equal(queries, 1)
  for (const changed of [{ transactionId: 'other-transaction' }, { appAccountToken: 'another-owner' },
    { bundleId: 'another-app' }, { productId: 'another-product' }, { environment: 'Production' }]) {
    current = appleTransaction(changed)
    await assert.rejects(client.verify(notification.locator), { code: 'APP_STORE_PROOF_INVALID' })
  }
  const signedPayload = appleJws(payload)
  const parts = signedPayload.split('.')
  const forged = JSON.parse(Buffer.from(parts[1], 'base64url'))
  forged.signedDate += 1
  parts[1] = Buffer.from(JSON.stringify(forged)).toString('base64url')
  await assert.rejects(client.verifyNotification('ios', { body: { signedPayload: parts.join('.') } }),
    { code: 'PAYMENT_NOTIFICATION_INVALID', statusCode: 403 })
})

test('Apple notification rejects missing type, invalid signed dates and missing transaction owner', async () => {
  const client = new AppStoreClient({ config: config(), now: () => now })
  const payload = { notificationUUID: 'reversal-1', notificationType: 'REFUND_REVERSED', version: '2.0',
    data: { bundleId: 'com.test.app', environment: 'Sandbox', signedTransactionInfo: appleJws(appleTransaction()) } }
  for (const changed of [
    ...[undefined, '', ' ', 42, 'x'.repeat(129)].map((notificationType) => ({ ...payload, notificationType })),
    ...[undefined, null, 0, -1, 1.5, String(now), now + 60_001].map((signedDate) => ({ ...payload, signedDate })),
    { ...payload, data: { ...payload.data,
      signedTransactionInfo: appleJws(appleTransaction({ appAccountToken: undefined })) } },
  ]) {
    await assert.rejects(client.verifyNotification('ios', { body: { signedPayload: appleJws(changed) } }),
      { code: 'PAYMENT_NOTIFICATION_INVALID', statusCode: 403 })
  }
})

test('Apple TEST notifications preserve verified metadata without requiring a transaction', async () => {
  const client = new AppStoreClient({ config: config(), now: () => now })
  const payload = { notificationUUID: 'test-1', notificationType: 'TEST', version: '2.0', signedDate: now + 60_000,
    data: { bundleId: 'com.test.app', environment: 'Sandbox' } }
  assert.deepEqual(await client.verifyNotification('ios', { body: { signedPayload: appleJws(payload) } }),
    { notificationId: 'test-1', notificationType: 'TEST', signedDate: now + 60_000, test: true })
})

function googleOidc(overrides = {}) {
  const input = [{ alg: 'RS256', kid: 'google-key' }, { iss: 'https://accounts.google.com',
    aud: 'https://app.example.com/payments/google', sub: 'push-service-account',
    exp: Math.floor(now / 1000) + 3600, iat: Math.floor(now / 1000),
    email: 'push@test.iam.gserviceaccount.com', email_verified: true, ...overrides }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')
  return `${input}.${sign('sha256', Buffer.from(input), rsa.privateKey).toString('base64url')}`
}

test('Google Pub/Sub requires verified OIDC audience/issuer/email and only returns validated purchase locators', async () => {
  const client = new AppStoreClient({ config: config(), now: () => now, fetchImpl: async (url) => {
    assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs')
    return json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'google-key', use: 'sig', alg: 'RS256' }] })
  } })
  const payload = { packageName: 'com.test.app', oneTimeProductNotification: { notificationType: 1, sku: 'vip.30.days', purchaseToken: 'purchase-token' } }
  const body = (value) => ({ message: { messageId: 'message-1', data: Buffer.from(JSON.stringify(value)).toString('base64') } })
  const result = await client.verifyNotification('android', { body: body(payload), headers: { authorization: `Bearer ${googleOidc()}` } })
  assert.deepEqual(result, { notificationId: 'message-1', locator: { platform: 'android', purchaseToken: 'purchase-token' } })
  for (const claims of [{ email: 'attacker@example.com' }, { email_verified: false }, { aud: 'wrong' }, { iss: 'https://attacker.example' }, { exp: 1 }]) {
    await assert.rejects(client.verifyNotification('android', { body: body(payload), headers: { authorization: `Bearer ${googleOidc(claims)}` } }),
      { code: 'PAYMENT_NOTIFICATION_INVALID' })
  }
  await assert.rejects(client.verifyNotification('android', { body: body({ ...payload, packageName: 'wrong' }),
    headers: { authorization: `Bearer ${googleOidc()}` } }), { code: 'PAYMENT_NOTIFICATION_INVALID' })
  const voided = { packageName: 'com.test.app', voidedPurchaseNotification: { purchaseToken: 'purchase-token', productType: 2, refundType: 1 } }
  assert.equal((await client.verifyNotification('android', { body: body(voided), headers: { authorization: `Bearer ${googleOidc()}` } })).locator.purchaseToken, 'purchase-token')
  await assert.rejects(client.verifyNotification('android', { body: body(payload), headers: {} }), { code: 'PAYMENT_NOTIFICATION_INVALID' })
})

test('Unconfigured stores and unavailable platform endpoints never imply a paid transaction', async () => {
  const empty = new AppStoreClient({ config: { platforms: {} } })
  await assert.rejects(empty.verify({ platform: 'ios', transactionId: '10000001' }), { code: 'APP_STORE_NOT_CONFIGURED' })
  const offline = new AppStoreClient({ config: config(), fetchImpl: async () => { throw new Error('network') } })
  await assert.rejects(offline.verify({ platform: 'ios', transactionId: '10000001' }), { code: 'APP_STORE_UNAVAILABLE' })
  const malformed = new AppStoreClient({ config: config(), fetchImpl: async () => new Response('not json') })
  await assert.rejects(malformed.verify({ platform: 'ios', transactionId: '10000001' }), { code: 'APP_STORE_UNAVAILABLE' })
})

test('Google invalid access tokens refresh once and repeated authentication errors fail closed', async () => {
  let oauthCalls = 0, attempts = 0, alwaysFail = false
  const client = new AppStoreClient({ config: config(), now: () => now, fetchImpl: async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls += 1
      return json({ access_token: `token-${oauthCalls}`, expires_in: 3600 })
    }
    attempts += 1
    return alwaysFail || attempts === 1 ? json({}, 401) : json(googleTransaction())
  } })
  assert.equal((await client.verify({ platform: 'android', purchaseToken: 'token' })).status, 'purchased')
  assert.equal(oauthCalls, 2)
  assert.equal(attempts, 2)
  alwaysFail = true
  await assert.rejects(client.verify({ platform: 'android', purchaseToken: 'token' }), { code: 'APP_STORE_UNAVAILABLE' })
  assert.equal(attempts, 4)
  assert.equal(oauthCalls, 3)
})
