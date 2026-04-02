require('dotenv').config()

const express = require('express')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
const WordLibrary = require('./data/WordLibrary')
const RoomManager = require('./room/RoomManager')
const { initializeSocketServer } = require('./socket')

const app = express()
const server = http.createServer(app)
const allowedOrigins = String(process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const wordLibrary = new WordLibrary()
const roomManager = new RoomManager({
  wordLibrary,
  disconnectGraceMs: Number(process.env.DISCONNECT_GRACE_MS || 30 * 1000),
  hostTransferGraceMs: Number(process.env.HOST_TRANSFER_GRACE_MS || 30 * 1000),
  allDisconnectedTtlMs: Number(
    process.env.ROOM_ALL_DISCONNECTED_TTL_MS || 10 * 60 * 1000
  ),
  emptyRoomTtlMs: Number(process.env.ROOM_EMPTY_TTL_MS || 5 * 60 * 1000),
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
  allowEIO3: true,  // 兼容 weapp.socket.io v2 (EIO=3)
})

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  })
)
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'qile-wodi-server',
    socket: {
      disconnectGraceMs: roomManager.disconnectGraceMs,
      hostTransferGraceMs: roomManager.hostTransferGraceMs,
      allDisconnectedTtlMs: roomManager.allDisconnectedTtlMs,
      emptyRoomTtlMs: roomManager.emptyRoomTtlMs,
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

initializeSocketServer(io, roomManager)

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 3010)

server.listen(port, host, () => {
  console.log(`QileWodi server listening on http://${host}:${port}`)
})
