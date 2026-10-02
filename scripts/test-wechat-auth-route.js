const assert = require('assert/strict')
const { createFixture } = require('./auth-fixture')

async function main() {
  const f = await createFixture()
  try {
    const first = await f.login('alice', { nickname: '旧昵称', avatar: 'legacy', openid: 'bob', playerId: 'legacy' })
    assert.equal(first.status, 200)
    assert.match(first.profile.nickname, /^玩家\d{4}$/)
    assert.match(first.profile.avatar, /^\/assets\/avatars\/avatar-([1-9]|[12]\d|3[0-2])\.svg$/)
    const repeat = await f.login('alice', {}, 'login')
    assert.equal(repeat.userId, first.userId)
    assert.equal(repeat.playerId, first.playerId)
    assert.deepEqual(repeat.profile, first.profile)
    const bob = await f.login('bob', { playerId: first.playerId, openid: 'verified-alice' })
    assert.notEqual(bob.userId, first.userId)
    assert.notEqual(bob.playerId, first.playerId)
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => f.login('new-user')))
    assert.equal(new Set(concurrent.map((result) => result.userId)).size, 1)
    assert.equal(f.userStore.db.prepare('SELECT count(*) AS n FROM users').get().n, 3)
    assert.equal(f.userStore.db.prepare('SELECT count(*) AS n FROM user_identities').get().n, 3)
    assert.equal((await f.login('')).status, 400)
    const session = f.manager.sessionRegistry.get(first.playerId)
    session.disconnectedAt = Date.now() - 86400001
    await f.login('alice')
    assert.equal(f.manager.cleanupExpiredSessions(), 0)
    console.log('WeChat auth route test passed.')
  } finally { await f.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
