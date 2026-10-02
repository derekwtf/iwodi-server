const { spawnSync } = require('child_process')
const scripts = [
  'test-word-library-loader.js', 'test-word-library.js', 'test-events-sync.js',
  'test-room-idle.js', 'test-room-identity.js', 'test-room-switch.js',
  'test-min-start-players.js', 'test-session-lifecycle.js', 'test-game-snapshot.js',
  'test-room-sync-state.js', 'test-room-reconnect-resilience.js',
  'test-wechat-auth-route.js', 'test-user-auth.test.js', 'test-socket-flow.js', 'test-connection.js',
]
for (const script of scripts) {
  const result = spawnSync(process.execPath, [`${__dirname}/${script}`], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
