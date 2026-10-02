const { randomUUID } = require('crypto')

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_SWEEP_MS = 60 * 60 * 1000

class SessionRegistry {
  constructor() {
    this.sessions = new Map()
    this.socketToPlayer = new Map()
    this.identityToPlayer = new Map()
    this.sweepTimer = setInterval(() => this.cleanupExpiredSessions(), SESSION_SWEEP_MS)
    this.sweepTimer.unref()
  }

  get(playerId) {
    return this.sessions.get(playerId) || null
  }

  getPlayerIdBySocketId(socketId) {
    return this.socketToPlayer.get(socketId) || null
  }

  resolvePlayerIdByIdentity(identityKey, preferredPlayerId = null) {
    const key = this._normalizeIdentityKey(identityKey)
    if (!key) {
      const error = new Error('缺少有效的用户身份')
      error.code = 'IDENTITY_REQUIRED'
      throw error
    }

    const existingPlayerId = this.identityToPlayer.get(key)
    if (existingPlayerId) {
      const existingSession = this.get(existingPlayerId)
      if (existingSession) {
        this._bindIdentity(existingSession, key)
        if (!existingSession.roomId && !existingSession.socketId) {
          existingSession.disconnectedAt = Date.now()
        }
        return existingPlayerId
      }
      this.identityToPlayer.delete(key)
    }

    const preferredSession = preferredPlayerId && this.get(preferredPlayerId)
    if (preferredSession && preferredSession.identityKey === key) {
      this._bindIdentity(preferredSession, key)
      if (!preferredSession.roomId && !preferredSession.socketId) {
        preferredSession.disconnectedAt = Date.now()
      }
      return preferredSession.playerId
    }

    return this._createSession(key).playerId
  }

  registerConnection({ playerId, socketId, identityKey }) {
    const key = this._normalizeIdentityKey(identityKey)
    const session = this.get(this.resolvePlayerIdByIdentity(key, playerId || null))
    const sessionNotFound = Boolean(playerId && playerId !== session.playerId)

    const previousSocketId = session.socketId && session.socketId !== socketId
      ? session.socketId
      : null
    if (previousSocketId) {
      this.socketToPlayer.delete(previousSocketId)
    }

    session.socketId = socketId || null
    session.disconnectedAt = null
    this._bindIdentity(session, key)
    if (socketId) {
      this.socketToPlayer.set(socketId, session.playerId)
    }

    return { session, previousSocketId, sessionNotFound }
  }

  markDisconnected(socketId) {
    const playerId = this.socketToPlayer.get(socketId)
    if (!playerId) {
      return null
    }
    this.socketToPlayer.delete(socketId)
    const session = this.get(playerId)
    if (!session || session.socketId !== socketId) {
      return null
    }
    session.socketId = null
    session.disconnectedAt = Date.now()
    return session
  }

  cleanupExpiredSessions(now = Date.now()) {
    let removed = 0
    for (const [playerId, session] of this.sessions) {
      if (session.roomId || session.socketId || session.disconnectedAt === null ||
          now - session.disconnectedAt < SESSION_TTL_MS) {
        continue
      }
      this.sessions.delete(playerId)
      if (session.identityKey && this.identityToPlayer.get(session.identityKey) === playerId) {
        this.identityToPlayer.delete(session.identityKey)
      }
      removed += 1
    }
    return removed
  }

  _createSession(identityKey = '') {
    const session = {
      playerId: randomUUID(),
      identityKey: '',
      socketId: null,
      roomId: null,
      disconnectedAt: Date.now(),
    }
    this.sessions.set(session.playerId, session)
    this._bindIdentity(session, identityKey)
    return session
  }

  _normalizeIdentityKey(identityKey) {
    return String(identityKey || '').trim()
  }

  _bindIdentity(session, identityKey) {
    const key = this._normalizeIdentityKey(identityKey)
    if (!key) {
      return
    }
    const existingPlayerId = this.identityToPlayer.get(key)
    if (existingPlayerId && existingPlayerId !== session.playerId) {
      const existingSession = this.get(existingPlayerId)
      if (existingSession && existingSession.identityKey === key) {
        return
      }
    }
    if (session.identityKey && session.identityKey !== key) {
      this.identityToPlayer.delete(session.identityKey)
    }
    session.identityKey = key
    this.identityToPlayer.set(key, session.playerId)
  }
}

module.exports = SessionRegistry
