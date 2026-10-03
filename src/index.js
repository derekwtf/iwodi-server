require('dotenv').config()

const express = require('express')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
const WordLibrary = require('./data/WordLibrary')
const RoomManager = require('./room/RoomManager')
const createAuthRouter = require('./auth/createAuthRouter')
const createWechatSessionFetcher = require('./auth/createWechatSessionFetcher')
const UserStore = require('./user/UserStore')
const { readPaymentConfig } = require('./payment/config')
const { PaymentService } = require('./payment/PaymentService')
const createEventsRouter = require('./payment/createEventsRouter')
const { createTokenService } = require('./auth/tokens')
const { initializeSocketServer } = require('./socket')

// 认证配置和数据库必须先初始化成功，随后才允许监听。
const tokens = createTokenService(process.env.AUTH_TOKEN_SECRET)
const userStore = new UserStore(process.env.USER_DB_PATH)
const fetchWechatSession = createWechatSessionFetcher({
  appId: process.env.WECHAT_APP_ID, appSecret: process.env.WECHAT_APP_SECRET,
  timeoutMs: Number(process.env.WECHAT_LOGIN_TIMEOUT_MS || 5000),
})
const paymentService = new PaymentService({ userStore, config: readPaymentConfig(), fetchWechatSession })
// Each active socket registers one private state listener.
paymentService.setMaxListeners(0)
const app = express()
const server = http.createServer(app)
const allowedOrigins = String(process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const wordLibrary = new WordLibrary()
const roomManager = new RoomManager({
  wordLibrary,
  minStartPlayers: process.env.MIN_START_PLAYERS,
  hostTransferGraceMs: Number(process.env.HOST_TRANSFER_GRACE_MS || 30 * 1000),
  allDisconnectedTtlMs: Number(
    process.env.ROOM_ALL_DISCONNECTED_TTL_MS || 10 * 60 * 1000
  ),
  waitingIdleMs: Number(process.env.ROOM_WAITING_IDLE_MS || 15 * 60 * 1000),
  playingIdleMs: Number(process.env.ROOM_PLAYING_IDLE_MS || 10 * 60 * 1000),
  endedIdleMs: Number(process.env.ROOM_ENDED_IDLE_MS || 5 * 60 * 1000),
  idleWarningMs: Number(process.env.ROOM_IDLE_WARNING_MS || 60 * 1000),
  voteReminderMs: Number(process.env.VOTE_REMINDER_MS || 2 * 60 * 1000),
  voteTimeoutMs: Number(process.env.VOTE_TIMEOUT_MS || 3 * 60 * 1000),
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
app.use('/wechat/events', createEventsRouter(paymentService))
app.use(
  '/auth',
  createAuthRouter({
    roomManager,
    userStore,
    tokens,
    appId: process.env.WECHAT_APP_ID,
    fetchWechatSession,
    paymentService,
  })
)

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'qile-wodi-server',
    auth: {
      wechatLoginConfigured: Boolean(
        process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET
      ),
    },
    socket: {
      hostTransferGraceMs: roomManager.hostTransferGraceMs,
      allDisconnectedTtlMs: roomManager.allDisconnectedTtlMs,
      waitingIdleMs: roomManager.waitingIdleMs,
      playingIdleMs: roomManager.playingIdleMs,
      endedIdleMs: roomManager.endedIdleMs,
      idleWarningMs: roomManager.idleWarningMs,
      voteReminderMs: roomManager.voteReminderMs,
      voteTimeoutMs: roomManager.voteTimeoutMs,
    },
    wordLibrarySize: wordLibrary.size,
  })
})

initializeSocketServer(io, roomManager, { userStore, tokens, paymentService })
paymentService.start()

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 3010)

server.listen(port, host, () => {
  console.log(`QileWodi server listening on http://${host}:${server.address().port}`)
})
