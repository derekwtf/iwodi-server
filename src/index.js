require('dotenv').config()

const express = require('express')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
const WordLibrary = require('./data/WordLibrary')
const BodyPromptLibrary = require('./data/BodyPromptLibrary')
const RoomManager = require('./room/RoomManager')
const createAuthRouter = require('./auth/createAuthRouter')
const createWechatSessionFetcher = require('./auth/createWechatSessionFetcher')
const UserStore = require('./user/UserStore')
const { readPaymentConfig } = require('./payment/config')
const { PaymentService } = require('./payment/PaymentService')
const { AppPaymentService } = require('./payment/AppPaymentService')
const { readAppPaymentConfig } = require('./payment/app-config')
const createEventsRouter = require('./payment/createEventsRouter')
const createAppEventsRouter = require('./payment/createAppEventsRouter')
const { createTokenService } = require('./auth/tokens')
const { createAppIdentityVerifier } = require('./auth/createAppIdentityVerifier')
const { AppleRevocationClient } = require('./auth/AppleRevocationClient')
const { initializeSocketServer } = require('./socket')
const deleteAccountSession = require('./socket/deleteAccountSession')
const { readAppWebConfig, createAppWebRouter } = require('./web/appWeb')

// 认证配置和数据库必须先初始化成功，随后才允许监听。
const channel = process.env.APP_CHANNEL || 'wechat'
if (!['wechat', 'app'].includes(channel)) throw new Error('APP_CHANNEL 必须为 wechat 或 app')
const tokens = createTokenService(process.env.AUTH_TOKEN_SECRET)
const userStore = new UserStore(process.env.USER_DB_PATH)
if (channel === 'app') {
  userStore.purgeInactiveGuests()
  userStore.purgeDeletedAppData()
}
const fetchWechatSession = channel === 'wechat' ? createWechatSessionFetcher({
  appId: process.env.WECHAT_APP_ID, appSecret: process.env.WECHAT_APP_SECRET,
  timeoutMs: Number(process.env.WECHAT_LOGIN_TIMEOUT_MS || 5000),
}) : null
const paymentService = channel === 'wechat'
  ? new PaymentService({ userStore, config: readPaymentConfig(), fetchWechatSession })
  : new AppPaymentService({ userStore, config: readAppPaymentConfig() })
const appIdentityVerifier = channel === 'app' ? createAppIdentityVerifier({
  appleClientId: process.env.APPLE_CLIENT_ID,
  googleClientId: process.env.GOOGLE_WEB_CLIENT_ID,
}) : null
const appleRevocationClient = channel === 'app' ? new AppleRevocationClient({ appIdentityVerifier, config: {
  clientId: process.env.APPLE_CLIENT_ID, teamId: process.env.APPLE_AUTH_TEAM_ID,
  keyId: process.env.APPLE_AUTH_KEY_ID, privateKey: String(process.env.APPLE_AUTH_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
} }) : null
const appWebConfig = channel === 'app' ? readAppWebConfig() : null
const app = express()
let stopping = false
if (channel === 'app') app.use((req, res, next) => {
  if (stopping) return res.status(503).json({ error: { code: 'SERVICE_STOPPING', message: '服务正在重启，请稍后重试' } })
  next()
})
if (channel === 'app' && process.env.APP_TRUST_PROXY) app.set('trust proxy', process.env.APP_TRUST_PROXY)
const server = http.createServer(app)
const allowedOrigins = String(process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const wordLibrary = new WordLibrary()
const roomManager = new RoomManager({
  wordLibrary,
  bodyPromptLibrary: new BodyPromptLibrary(),
  hostTransferGraceMs: Number(process.env.HOST_TRANSFER_GRACE_MS || 30 * 1000),
  allDisconnectedTtlMs: Number(
    process.env.ROOM_ALL_DISCONNECTED_TTL_MS || 10 * 60 * 1000
  ),
  waitingIdleMs: Number(process.env.ROOM_WAITING_IDLE_MS || 15 * 60 * 1000),
  playingIdleMs: Number(process.env.ROOM_PLAYING_IDLE_MS || 10 * 60 * 1000),
  idleWarningMs: Number(process.env.ROOM_IDLE_WARNING_MS || 60 * 1000),
})
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    methods: ['GET', 'POST'],
  },
  // weapp.socket.io 2.2.1 发布包实际使用 EIO=4 / Socket.IO 协议 5，支持 auth。
})

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  })
)
app.use(express.json({ limit: '128kb' }))
if (channel === 'wechat') app.use('/wechat/events', createEventsRouter(paymentService))
else app.use('/app/store/events', createAppEventsRouter(paymentService))
app.use(
  '/auth',
  createAuthRouter({
    roomManager,
    userStore,
    tokens,
    appId: process.env.WECHAT_APP_ID,
    fetchWechatSession,
    paymentService,
    channel,
    appIdentityVerifier,
    appleRevocationClient,
    deleteSession: (userId) => deleteAccountSession(io, roomManager, userId),
  })
)
if (appWebConfig) app.use(createAppWebRouter(appWebConfig))

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'qile-wodi-server',
    auth: {
      channel,
      wechatLoginConfigured: Boolean(
        channel === 'wechat' && process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET
      ),
      ...(appIdentityVerifier ? { appLoginConfigured: appIdentityVerifier.configured } : {}),
      ...(appleRevocationClient ? { appleDeletionConfigured: appleRevocationClient.configured } : {}),
    },
    ...(appWebConfig ? { publicPages: appWebConfig.status } : {}),
    socket: {
      hostTransferGraceMs: roomManager.hostTransferGraceMs,
      allDisconnectedTtlMs: roomManager.allDisconnectedTtlMs,
      waitingIdleMs: roomManager.waitingIdleMs,
      playingIdleMs: roomManager.playingIdleMs,
      idleWarningMs: roomManager.idleWarningMs,
    },
    wordLibrarySize: wordLibrary.size,
  })
})

initializeSocketServer(io, roomManager, { userStore, tokens, paymentService })
paymentService?.start()
// Retention applies even while payments and advertising are disabled.
const retentionTimer = channel === 'app' ? setInterval(() => {
  try {
    userStore.purgeInactiveGuests({ isActive: (userId) => roomManager.hasActiveIdentity(userId) })
    userStore.purgeDeletedAppData()
  }
  catch (error) { console.warn('[app-account-cleanup]', error.code || 'CLEANUP_FAILED') }
}, 60_000) : null
retentionTimer?.unref()
server.once('close', () => {
  clearInterval(retentionTimer)
  void paymentService?.stop()
})

if (channel === 'app') {
  const shutdown = () => {
    if (stopping) return
    stopping = true
    // Stop new connections and recurring work. Accepted HTTP operations and
    // already running platform calls can still complete their durable writes.
    clearInterval(retentionTimer)
    clearInterval(roomManager.sessionRegistry.sweepTimer)
    void paymentService.stop()
    void io.close()
    for (const roomId of roomManager.rooms.keys()) roomManager.destroyRoom(roomId)
    const deadline = setTimeout(() => {
      console.error('[app-shutdown] DRAIN_TIMEOUT')
      process.exit(1)
    }, 25_000)
    deadline.unref()
    // A disconnected HTTP client does not mean its async handler has finished.
    // Keep SQLite open until the event loop drains, including those late writes.
    process.once('beforeExit', () => {
      clearTimeout(deadline)
      try { userStore.close() }
      catch (_) { console.error('[app-shutdown] STORE_CLOSE_FAILED'); process.exitCode = 1 }
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 3010)

server.listen(port, host, () => {
  console.log(`QileWodi server listening on http://${host}:${server.address().port}`)
})
