const test = require('node:test')
const assert = require('node:assert/strict')
const { createFixture, request } = require('./auth-fixture')

test('App orders use authenticated Socket actions, synchronize rooms, restore once and revoke only verified refunds', async () => {
  const config = { enabled: true, configured: true, productId: 'vip_month', durationDays: 30, platforms: {
    ios: { enabled: true, configured: true, appId: 'fixture.ios', storeProductId: 'vip.ios', environment: 'sandbox' },
    android: { enabled: true, configured: true, appId: 'fixture.android', storeProductId: 'vip.android', environment: 'sandbox' },
  } }
  const transactions = new Map()
  const platform = {
    verify: async (input) => {
      const found = transactions.get(input.purchaseToken || input.transactionId)
      if (!found) throw Object.assign(new Error('fixture verification failed'), { code: 'APP_STORE_PROOF_INVALID' })
      return { ...found }
    },
    complete: async (verified) => ({ finished: verified.platform === 'android' }),
    verifyNotification: async (_platform, { body, headers }) => {
      if (headers.authorization !== 'Bearer fixture-notification') throw Object.assign(new Error('invalid source'), { code: 'PAYMENT_NOTIFICATION_INVALID' })
      return { locator: body }
    },
  }
  const fixture = await createFixture(':memory:', { channel: 'app', appPayment: { config, client: platform, logger: { warn() {} } },
    appIdentityVerifier: { requireProvider(provider) { assert.equal(provider, 'google') },
      async verify({ identityToken }) { return { provider: 'google', scope: 'fixture.app', subject: identityToken } } } })
  try {
    const alice = await fixture.login('', { provider: 'google', identityToken: 'alice' }, 'app-login')
    const bob = await fixture.login('', { provider: 'google', identityToken: 'bob' }, 'app-login')
    assert.equal(alice.status, 200)
    assert.equal('priceFen' in alice.membership, false)
    assert.deepEqual(alice.membership.storeProducts, { ios: 'vip.ios', android: 'vip.android' })
    const a = await fixture.connect({ token: alice.token })
    const b = await fixture.connect({ token: bob.token })
    const createdRoom = await request(a.socket, 'room:create', { playMode: 'language' })
    await request(b.socket, 'room:join', { roomId: createdRoom.room.roomId })

    const created = await request(a.socket, 'user:createVipOrder', { platform: 'android', productId: 'vip_month', requestId: 'android-order-fixture-1' })
    assert.equal(created.ok, true)
    assert.equal(created.membership.isVip, false)
    assert.equal(created.order.status, 'pending')
    const duplicate = await request(a.socket, 'user:createVipOrder', { platform: 'android', productId: 'vip_month', requestId: 'android-order-fixture-1' })
    assert.equal(duplicate.order.outTradeNo, created.order.outTradeNo)
    assert.equal(duplicate.payment, undefined)
    const second = await request(a.socket, 'user:createVipOrder', { platform: 'android', productId: 'vip_month', requestId: 'android-order-fixture-2' })
    assert.equal(second.error.code, 'VIP_ORDER_PENDING')
    const proof = { platform: 'android', environment: 'sandbox', appId: 'fixture.android', storeProductId: 'vip.android',
      transactionId: 'fixture-transaction', purchaseToken: 'fixture-purchase-token', accountToken: created.payment.accountToken,
      purchasedAt: Date.now(), quantity: 1, status: 'purchased' }
    transactions.set(proof.purchaseToken, proof)
    const foreign = await request(b.socket, 'user:confirmVipPurchase', { platform: 'android', purchaseToken: proof.purchaseToken })
    assert.equal(foreign.error.code, 'VIP_ORDER_NOT_FOUND')
    const granted = await request(a.socket, 'user:confirmVipPurchase', { platform: 'android', purchaseToken: proof.purchaseToken })
    assert.equal(granted.ok, true)
    assert.equal(granted.order.status, 'granted')
    assert.ok(granted.order.finishedAt)
    assert.equal(granted.membership.isVip, true)
    assert.equal(JSON.stringify(granted).includes(proof.purchaseToken), false)
    assert.equal(fixture.manager.getRoomState(createdRoom.room.roomId).players.find((player) => player.id === a.playerId).isVip, true)
    assert.equal((await request(a.socket, 'room:updateProfile', { nickname: 'VIP', avatar: '/assets/avatars/avatar-9.svg' })).ok, true)
    const restored = await request(a.socket, 'user:queryVipOrder', { restore: true })
    assert.equal(restored.orders.length, 1)
    assert.equal(restored.membership.vipExpiresAt, granted.membership.vipExpiresAt)

    const badPush = await fetch(`${fixture.url}/app/store/events/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(badPush.status, 403)
    transactions.set(proof.purchaseToken, { ...proof, status: 'refunded', refundId: 'fixture-refund', refundedAt: Date.now() })
    for (let repeat = 0; repeat < 2; repeat++) {
      const push = await fetch(`${fixture.url}/app/store/events/google`, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer fixture-notification',
      }, body: JSON.stringify({ platform: 'android', purchaseToken: proof.purchaseToken }) })
      assert.equal(push.status, 204)
    }
    const refunded = await request(a.socket, 'user:queryVipOrder', { outTradeNo: created.order.outTradeNo })
    assert.equal(refunded.order.status, 'refunded')
    assert.equal(refunded.membership.isVip, false)
    assert.equal(refunded.profile.avatar, alice.profile.avatar)
    assert.equal(fixture.manager.getRoomState(createdRoom.room.roomId).players.find((player) => player.id === a.playerId).isVip, false)

    const apple = await request(a.socket, 'user:createVipOrder', { platform: 'ios', productId: 'vip_month', requestId: 'apple-order-fixture-1' })
    transactions.set('apple-tx', { platform: 'ios', environment: 'sandbox', appId: 'fixture.ios', storeProductId: 'vip.ios',
      transactionId: 'apple-tx', accountToken: apple.payment.accountToken, purchasedAt: Date.now(), quantity: 1, status: 'purchased' })
    const applePaid = await request(a.socket, 'user:confirmVipPurchase', { platform: 'ios', transactionId: 'apple-tx' })
    assert.equal(applePaid.order.status, 'granted')
    assert.equal(applePaid.order.finishedAt, null)
    const appleFinished = await request(a.socket, 'user:queryVipOrder', { outTradeNo: apple.order.outTradeNo, nativeFinished: true })
    assert.ok(appleFinished.order.finishedAt)
    assert.equal(appleFinished.membership.vipExpiresAt, applePaid.membership.vipExpiresAt)
  } finally { await fixture.close() }
})
