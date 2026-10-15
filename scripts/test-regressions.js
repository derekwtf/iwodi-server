const { spawnSync } = require('child_process')
const scripts = [
  'test-word-library-loader.js', 'test-word-library.js', 'test-events-sync.js',
  'test-room-idle.js', 'test-room-identity.js', 'test-room-switch.js',
  'test-min-start-players.js', 'test-play-mode.test.js', 'test-session-lifecycle.js', 'test-game-snapshot.js',
  'test-room-sync-state.js', 'test-room-reconnect-resilience.js',
  'test-wechat-auth-route.js', 'test-user-auth.test.js', 'test-app-auth.test.js', 'test-vip.test.js', 'test-virtual-payment.test.js', 'test-socket-flow.js', 'test-connection.js',
  'test-app-payment-ledger.test.js', 'test-app-store-client.test.js', 'test-app-payment-service.test.js', 'test-app-payment-socket.test.js',
  'test-apple-revocation.test.js', 'test-account-deletion.test.js', 'test-account-deletion-socket.test.js', 'test-app-retention.test.js', 'test-app-web.test.js',
  'test-app-backup.test.js', 'test-app-shutdown.test.js',
]
for (const script of scripts) {
  const result = spawnSync(process.execPath, [`${__dirname}/${script}`], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
