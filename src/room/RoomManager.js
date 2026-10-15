const { EventEmitter } = require('events')
const { randomInt } = require('crypto')
const GameState = require('../game/GameState')
const SessionRegistry = require('./SessionRegistry')
const stateProjection = require('./stateProjection')
const { getPlayRules, getMaxSpyCount, getDefaultSpyCount } = require('./playMode')

class RoomManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.rooms = new Map()
    this.sessionRegistry = new SessionRegistry()
    this.wordLibrary = options.wordLibrary || null
    this.bodyPromptLibrary = options.bodyPromptLibrary || null
    this.hostTransferGraceMs = options.hostTransferGraceMs || 30 * 1000
    this.allDisconnectedTtlMs = options.allDisconnectedTtlMs || 10 * 60 * 1000
    this.waitingIdleMs = options.waitingIdleMs || 15 * 60 * 1000
    this.playingIdleMs = options.playingIdleMs || 10 * 60 * 1000
    this.idleWarningMs = options.idleWarningMs || 60 * 1000
  }

  registerConnection({ playerId, socketId, identityKey, profile }) {
    const { session, previousSocketId, sessionNotFound } =
      this.sessionRegistry.registerConnection({ playerId, socketId, identityKey })
    let reconnectEvent = sessionNotFound
      ? {
          event: 'reconnect:expired',
          payload: { reason: 'session_not_found', previousPlayerId: playerId },
        }
      : null

    const room = session.roomId ? this.rooms.get(session.roomId) : null
    if (room) {
      const player = this._findPlayer(room, session.playerId)
      if (player) {
        player.disconnected = false
        player.disconnectedAt = null
        if (profile) this.updatePlayerProfile(session.playerId, profile)
      }
      this._clearHostTransfer(room, session.playerId)
      this._refreshPresenceState(room)
      this._ensureHostTransfer(room)

      reconnectEvent = {
        event:
          room.status === 'waiting'
            ? 'reconnect:roomState'
            : 'reconnect:gameSnapshot',
        payload:
          room.status === 'waiting'
            ? this.getRoomState(room.id)
            : this.getReconnectGameSnapshot(room.id, session.playerId),
      }
    } else if (session.roomId) {
      session.roomId = null
      reconnectEvent = {
        event: 'reconnect:expired',
        payload: {
          reason: 'room_not_found',
        },
      }
    }

    return {
      playerId: session.playerId,
      previousSocketId,
      reconnectEvent,
    }
  }

  getPlayerIdBySocketId(socketId) {
    return this.sessionRegistry.getPlayerIdBySocketId(socketId)
  }

  resolvePlayerIdByIdentity(identityKey, preferredPlayerId = null) {
    return this.sessionRegistry.resolvePlayerIdByIdentity(identityKey, preferredPlayerId)
  }

  getRoomIdForPlayer(playerId) {
    const session = this.sessionRegistry.get(playerId)
    return session ? session.roomId : null
  }

  getActiveSocketId(playerId) {
    const session = this.sessionRegistry.get(playerId)
    return session ? session.socketId : null
  }

  createRoom({ playerId, nickname, avatar, vipExpiresAt = 0, lastNormalAvatar, playMode = 'language' }) {
    const session = this._getRequiredSession(playerId)

    getPlayRules(playMode)

    let previousRoomResult = null
    if (session.roomId) {
      previousRoomResult = this.leaveRoom(session.roomId, playerId, {
        reason: 'switch_room',
      })
    }

    const now = Date.now()

    const room = {
      id: this._generateRoomId(),
      players: [
        this._buildPlayer({
          playerId,
          nickname,
          avatar, vipExpiresAt, lastNormalAvatar,
          isHost: true,
        }),
      ],
      spyCount: 1,
      playMode,
      status: 'waiting',
      gameState: null,
      createdAt: Date.now(),
      spyCountManual: false,
      idleTimer: null,
      idleWarningTimer: null,
      hostTransferTimer: null,
      hostTransferPlayerId: null,
      allDisconnectedAt: null,
      lastActivityAt: now,
      lastHeartbeatAt: now,
      usedPromptPairIds: { language: [], body: [] },
    }

    session.roomId = room.id

    this.rooms.set(room.id, room)
    this._refreshSpyCount(room)
    this._markRoomActive(room)

    return {
      room,
      player: this._toPublicPlayer(room.players[0]),
      previousRoomResult,
    }
  }

  joinRoom(roomId, { playerId, nickname, avatar, vipExpiresAt = 0, lastNormalAvatar }) {
    const room = this.rooms.get(String(roomId || ''))
    if (!room) {
      throw this._createError('ROOM_NOT_FOUND', '房间不存在')
    }

    const session = this._getRequiredSession(playerId)

    if (room.status !== 'waiting') {
      throw this._createError('GAME_ALREADY_STARTED', '游戏已开始，无法加入')
    }

    const existingPlayer = this._findPlayer(room, playerId)
    if (existingPlayer) {
      existingPlayer.nickname = this._normalizeNickname(nickname)
      existingPlayer.avatar = this._normalizeAvatar(avatar)
      existingPlayer.vipExpiresAt = vipExpiresAt
      existingPlayer.lastNormalAvatar = lastNormalAvatar
      existingPlayer.disconnected = false
      existingPlayer.disconnectedAt = null
      session.roomId = room.id
      this._markRoomActive(room)

      return {
        room,
        player: this._toPublicPlayer(existingPlayer),
        alreadyInRoom: true,
      }
    }

    if (room.players.length >= getPlayRules(room.playMode).maxPlayers) {
      throw this._createError('ROOM_FULL', '房间已满，无法加入')
    }

    let previousRoomResult = null
    if (session.roomId && session.roomId !== room.id) {
      previousRoomResult = this.leaveRoom(session.roomId, playerId, {
        reason: 'switch_room',
      })
    }

    const player = this._buildPlayer({
      playerId,
      nickname,
      avatar, vipExpiresAt, lastNormalAvatar,
      isHost: room.players.length === 0,
    })

    room.players.push(player)
    session.roomId = room.id
    this._refreshSpyCount(room)
    this._markRoomActive(room)

    return {
      room,
      player: this._toPublicPlayer(player),
      alreadyInRoom: false,
      previousRoomResult,
    }
  }

  leaveRoomByPlayerId(playerId, options = {}) {
    const session = this.sessionRegistry.get(playerId)
    if (!session || !session.roomId) {
      return null
    }

    return this.leaveRoom(session.roomId, playerId, options)
  }

  kickPlayer(hostPlayerId, targetPlayerId) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(hostPlayerId)
    this._assertHost(player)

    if (room.status !== 'waiting') {
      throw this._createError('GAME_ALREADY_STARTED', '游戏开始后无法移出玩家')
    }

    if (hostPlayerId === targetPlayerId) {
      throw this._createError('HOST_KICK_SELF_NOT_ALLOWED', '房主不能移出自己')
    }

    const targetPlayer = this._findPlayer(room, targetPlayerId)
    if (!targetPlayer) {
      throw this._createError('PLAYER_NOT_IN_ROOM', '目标玩家不在房间中')
    }

    return this.leaveRoom(room.id, targetPlayerId, {
      reason: 'kick',
    })
  }

  leaveRoom(roomId, playerId, options = {}) {
    const room = this.rooms.get(roomId)
    const session = this.sessionRegistry.get(playerId)

    if (!room || !session) {
      return null
    }

    const playerIndex = room.players.findIndex((item) => item.id === playerId)
    if (playerIndex === -1) {
      session.roomId = null
      return null
    }

    const [removedPlayer] = room.players.splice(playerIndex, 1)
    session.roomId = null
    this._removePlayerFromGameState(room, playerId, options.reason)

    let hostChanged = null
    if (removedPlayer.isHost && room.players.length > 0) {
      const nextHost = room.players[randomInt(room.players.length)]
      if (nextHost) {
        nextHost.isHost = true
        hostChanged = this._toPublicPlayer(nextHost)
      }
    }

    const gameAction = this._resolveGameStateAfterLeave(room)

    if (room.players.length === 0) {
      room.status = 'waiting'
      room.gameState = null
      this.destroyRoom(room.id)
    } else {
      this._clearHostTransfer(room, playerId)
      this._refreshSpyCount(room)
      this._markRoomActive(room)
    }

    return {
      roomId: room.id,
      roomState: this.getRoomState(room.id),
      removedPlayer: options.reason === 'account_deleted'
        ? { ...this._toPublicPlayer(removedPlayer), nickname: '已删除账号', avatar: '/assets/avatars/avatar-1.svg', isVip: false }
        : this._toPublicPlayer(removedPlayer),
      hostChanged,
      gameAction,
      reason: options.reason || 'leave',
    }
  }

  setSpyCount(playerId, requestedCount) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)
    if (room.status !== 'waiting') {
      throw this._createError('GAME_ALREADY_STARTED', '游戏已开始，无法调整卧底人数')
    }

    const maxSpyCount = getMaxSpyCount(room.playMode, room.players.length)
    const nextSpyCount = requestedCount
    if (!Number.isInteger(nextSpyCount) || nextSpyCount < 1 || nextSpyCount > maxSpyCount) {
      throw this._createError('INVALID_SPY_COUNT', '卧底人数不符合当前玩法规则')
    }

    room.spyCount = nextSpyCount
    room.spyCountManual = true
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      spyCount: room.spyCount,
    }
  }

  setPlayMode(playerId, playMode) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)
    if (room.status !== 'waiting') {
      throw this._createError('GAME_ALREADY_STARTED', '游戏已开始，无法切换玩法')
    }
    getPlayRules(playMode)
    if (room.playMode !== playMode) {
      room.playMode = playMode
      this._markRoomActive(room)
    }
    return { room, roomState: this.getRoomState(room.id) }
  }

  requireProfileMember(playerId) {
    return this._getRoomAndPlayerByPlayerId(playerId)
  }

  updatePlayerProfile(playerId, { nickname, avatar, vipExpiresAt, lastNormalAvatar } = {}, { markActive = true } = {}) {
    const { room, player } = this.requireProfileMember(playerId)
    const nextNickname = String(nickname || '').trim()
      ? this._normalizeNickname(nickname)
      : player.nickname
    const nextAvatar = avatar === undefined
      ? player.avatar
      : this._normalizeAvatar(avatar)

    player.nickname = nextNickname
    player.avatar = nextAvatar
    if (vipExpiresAt !== undefined) player.vipExpiresAt = vipExpiresAt
    if (lastNormalAvatar !== undefined) player.lastNormalAvatar = lastNormalAvatar
    if (room.gameState && Array.isArray(room.gameState.playerRoster)) {
      const rosterPlayer = room.gameState.playerRoster.find((item) => item.id === playerId)
      if (rosterPlayer) {
        rosterPlayer.nickname = nextNickname
        rosterPlayer.avatar = nextAvatar
        rosterPlayer.vipExpiresAt = player.vipExpiresAt
        rosterPlayer.lastNormalAvatar = player.lastNormalAvatar
      }
    }

    if (markActive) this._markRoomActive(room)

    return {
      room,
      player: this._toPublicPlayer(player),
      roomState: this.getRoomState(room.id),
      gameState: room.gameState
        ? this.getGamePublicState(room.id)
        : null,
    }
  }

  startGame(playerId, playMode) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)
    if (room.status !== 'waiting') {
      throw this._createError('GAME_ALREADY_STARTED', '当前房间已开始游戏')
    }
    getPlayRules(playMode)
    if (playMode !== room.playMode) {
      throw this._createError('PLAY_MODE_MISMATCH', '玩法已更新，请确认最新房间配置后开局')
    }
    const rules = getPlayRules(room.playMode)
    if (room.players.length < rules.minPlayers || room.players.length > rules.maxPlayers) {
      throw this._createError('NOT_ENOUGH_PLAYERS', '当前人数不符合玩法要求：' + rules.minPlayers + '～' + rules.maxPlayers + ' 人')
    }
    if (!Number.isInteger(room.spyCount) || room.spyCount < 1 ||
      room.spyCount > getMaxSpyCount(room.playMode, room.players.length)) {
      throw this._createError('INVALID_SPY_COUNT', '卧底人数不符合当前玩法规则')
    }
    const wordLibrary = room.playMode === 'body' ? this.bodyPromptLibrary : this.wordLibrary
    if (!wordLibrary) {
      throw this._createError('WORD_LIBRARY_NOT_READY', '当前玩法词库未加载，请稍后重试')
    }
    const gameState = GameState.createGameState({
      players: room.players,
      spyCount: room.spyCount,
      playMode: room.playMode,
      wordLibrary,
      usedPromptPairIds: room.usedPromptPairIds[room.playMode],
    })
    // Private ownership is retained only for this in-memory round so deleting
    // an account can also erase a departed player's roster after session expiry.
    gameState.playerIdentities = Object.fromEntries(room.players.map((item) =>
      [item.id, this.sessionRegistry.get(item.id)?.identityKey || '']))
    const history = gameState.historyReset ? [] : room.usedPromptPairIds[room.playMode]
    room.gameState = gameState
    room.status = 'playing'
    room.usedPromptPairIds[room.playMode] = [...history, gameState.promptPairKey]
    this._markRoomActive(room)
    return { room, roomState: this.getRoomState(room.id) }
  }

  restartGame(playerId) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)
    this._assertGamePhase(room, ['dealing'])

    room.status = 'waiting'
    room.gameState = null
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
    }
  }

  markDisconnected(socketId) {
    const session = this.sessionRegistry.markDisconnected(socketId)
    if (!session || !session.roomId) {
      return null
    }
    const room = this.rooms.get(session.roomId)
    if (!room) {
      session.roomId = null
      return null
    }
    const player = this._findPlayer(room, session.playerId)
    if (!player) {
      session.roomId = null
      return null
    }

    player.disconnected = true
    player.disconnectedAt = session.disconnectedAt
    this._ensureHostTransfer(room)
    this._refreshPresenceState(room)

    return {
      playerId: session.playerId,
      roomId: room.id,
      player: this._toPublicPlayer(player),
      roomState: this.getRoomState(room.id),
    }
  }

  abandonReconnect(playerId) {
    return this.leaveRoomByPlayerId(playerId, {
      reason: 'reconnect_abandon',
    })
  }

  forgetIdentityHistory(identityKey, knownPlayerId) {
    const changes = []
    for (const room of this.rooms.values()) {
      const ids = room.gameState?.playerRoster.filter((player) => player.id === knownPlayerId ||
        room.gameState.playerIdentities?.[player.id] === identityKey).map((player) => player.id) || []
      if (!ids.length) continue
      ids.forEach((playerId) => this._removePlayerFromGameState(room, playerId, 'account_deleted'))
      changes.push({ roomId: room.id, payload: this.getGamePublicState(room.id) })
    }
    return changes
  }

  heartbeat(playerId) {
    const { room } = this._getRoomAndPlayerByPlayerId(playerId)
    this._markRoomActive(room, {
      heartbeat: true,
    })

    return {
      room,
      roomState: this.getRoomState(room.id),
      status: room.status,
    }
  }

  getSyncState(playerId) {
    const session = this._getRequiredSession(playerId)
    if (!session.roomId) {
      throw this._createError('ROOM_NOT_FOUND', '房间不存在或已关闭')
    }

    const room = this.rooms.get(session.roomId)
    if (!room) {
      session.roomId = null
      throw this._createError('ROOM_NOT_FOUND', '房间不存在或已关闭')
    }

    const player = this._findPlayer(room, playerId)
    if (!player) {
      session.roomId = null
      throw this._createError('PLAYER_NOT_IN_ROOM', '房间不存在或已关闭')
    }

    return {
      room: this.getRoomState(room.id),
      game: room.gameState ? this.getReconnectGameSnapshot(room.id, playerId) : null,
      status: room.gameState ? room.gameState.phase : room.status,
    }
  }

  keepAlive(playerId) {
    const { room } = this._getRoomAndPlayerByPlayerId(playerId)
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      status: room.status,
    }
  }

  getRoomState(roomId) {
    return stateProjection.getRoomState(this.rooms.get(roomId))
  }

  getGamePublicState(roomId) {
    return stateProjection.getGamePublicState(this.rooms.get(roomId))
  }

  getReconnectGameSnapshot(roomId, playerId) {
    return stateProjection.getReconnectGameSnapshot(this.rooms.get(roomId), playerId)
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) {
      return false
    }

    this._clearRoomIdleTimers(room)
    this._clearHostTransfer(room)
    for (const player of room.players) {
      const session = this.sessionRegistry.get(player.id)
      if (session && session.roomId === roomId) {
        session.roomId = null
      }
    }
    this.rooms.delete(roomId)
    this.emit('room:destroyed', { roomId })
    return true
  }

  closeRoom(roomId, options = {}) {
    const room = this.rooms.get(roomId)
    if (!room) {
      return null
    }

    const roomState = this.getRoomState(roomId)
    const activePlayerIds = []
    room.players.forEach((player) => {
      const session = this.sessionRegistry.get(player.id)
      if (!session) {
        return
      }

      if (session.socketId) {
        activePlayerIds.push(player.id)
      }

      session.roomId = null
    })

    const payload = {
      roomId,
      reason: options.reason || 'room_closed',
      previousStatus: room.status,
      roomState,
      activePlayerIds,
    }

    this.emit('room:closed', payload)
    this.destroyRoom(roomId)

    return payload
  }

  cleanupExpiredSessions(now = Date.now()) {
    return this.sessionRegistry.cleanupExpiredSessions(now)
  }

  _buildPlayer({ playerId, nickname, avatar, vipExpiresAt = 0, lastNormalAvatar, isHost }) {
    return {
      id: playerId,
      nickname: this._normalizeNickname(nickname),
      avatar: this._normalizeAvatar(avatar),
      vipExpiresAt,
      lastNormalAvatar,
      isReady: true,
      isHost: Boolean(isHost),
      disconnected: false,
      disconnectedAt: null,
      joinedAt: Date.now(),
    }
  }

  _generateRoomId() {
    let roomId = ''
    do {
      roomId = String(randomInt(100000, 1000000))
    } while (this.rooms.has(roomId))

    return roomId
  }

  _refreshSpyCount(room) {
    if (!room.spyCountManual) {
      room.spyCount = getDefaultSpyCount(room.playMode, room.players.length)
      return
    }
    room.spyCount = Math.max(1, Math.min(getMaxSpyCount(room.playMode, room.players.length), room.spyCount))
  }

  _removePlayerFromGameState(room, playerId, reason) {
    if (!room.gameState) return
    delete room.gameState.roles[playerId]
    delete room.gameState.playerWords[playerId]
    delete room.gameState.playerPerformanceSteps[playerId]
    if (reason === 'account_deleted') {
      delete room.gameState.playerIdentities?.[playerId]
      room.gameState.playerRoster = room.gameState.playerRoster.filter((player) => player.id !== playerId)
      return
    }
    const rosterPlayer = room.gameState.playerRoster.find((player) => player.id === playerId)
    if (rosterPlayer) {
      rosterPlayer.hasLeft = true
      rosterPlayer.leftReason = reason || 'leave'
    }
  }

  _resolveGameStateAfterLeave(room) {
    if (!room.gameState || room.players.length === 0) return null
    return { type: 'stateSync', payload: this.getGamePublicState(room.id) }
  }

  _markRoomActive(room, options = {}) {
    if (!room) {
      return
    }

    const now = Date.now()
    if (!options.heartbeat) {
      room.lastActivityAt = now
    }
    if (options.heartbeat || room.status === 'playing') {
      room.lastHeartbeatAt = now
    }
    if (this._getOnlinePlayers(room).length > 0) {
      room.allDisconnectedAt = null
    }
    this._scheduleRoomIdleCheck(room)
  }

  _getRoomIdlePolicy(room) {
    if (!room || room.players.length === 0) {
      return null
    }

    if (
      this._getOnlinePlayers(room).length === 0 &&
      this.allDisconnectedTtlMs > 0
    ) {
      return {
        ttlMs: this.allDisconnectedTtlMs,
        baseAt: room.allDisconnectedAt || room.createdAt || Date.now(),
        reason: 'all_disconnected_timeout',
      }
    }

    if (room.status === 'waiting') {
      return {
        ttlMs: this.waitingIdleMs,
        baseAt: room.lastActivityAt || room.createdAt || Date.now(),
        reason: 'waiting_idle_timeout',
      }
    }

    return {
      ttlMs: this.playingIdleMs,
      baseAt: Math.max(
        room.lastActivityAt || 0,
        room.lastHeartbeatAt || 0,
        room.createdAt || 0
      ),
      reason: 'playing_idle_timeout',
    }
  }

  _scheduleRoomIdleCheck(room) {
    this._clearRoomIdleTimers(room)

    const policy = this._getRoomIdlePolicy(room)
    if (!policy || !policy.ttlMs) {
      return
    }

    const deadlineAt = policy.baseAt + policy.ttlMs
    const delayMs = Math.max(deadlineAt - Date.now(), 0)
    room.idleTimer = setTimeout(() => {
      const latestRoom = this.rooms.get(room.id)
      if (!latestRoom) {
        return
      }

      const latestPolicy = this._getRoomIdlePolicy(latestRoom)
      if (!latestPolicy) {
        return
      }

      const latestDeadlineAt = latestPolicy.baseAt + latestPolicy.ttlMs
      if (latestDeadlineAt > Date.now()) {
        this._scheduleRoomIdleCheck(latestRoom)
        return
      }

      this.closeRoom(latestRoom.id, {
        reason: latestPolicy.reason,
      })
    }, delayMs)
    room.idleTimer.unref()

    if (this.idleWarningMs < policy.ttlMs) {
      const warningDelayMs = deadlineAt - Date.now() - this.idleWarningMs
      if (warningDelayMs >= 0) {
        room.idleWarningTimer = setTimeout(() => {
          const latestRoom = this.rooms.get(room.id)
          if (!latestRoom) {
            return
          }

          const latestPolicy = this._getRoomIdlePolicy(latestRoom)
          if (!latestPolicy) {
            return
          }

          const latestDeadlineAt = latestPolicy.baseAt + latestPolicy.ttlMs
          const remainingMs = latestDeadlineAt - Date.now()
          if (remainingMs <= 0 || remainingMs > this.idleWarningMs + 1000) {
            return
          }

          this.emit('room:idleWarning', {
            roomId: latestRoom.id,
            status: latestRoom.status,
            reason: latestPolicy.reason,
            remainingMs: Math.max(remainingMs, 0),
          })
        }, warningDelayMs)
        room.idleWarningTimer.unref()
      }
    }
  }

  _clearRoomIdleTimers(room) {
    if (!room) {
      return
    }

    if (room.idleTimer) {
      clearTimeout(room.idleTimer)
      room.idleTimer = null
    }

    if (room.idleWarningTimer) {
      clearTimeout(room.idleWarningTimer)
      room.idleWarningTimer = null
    }
  }

  _getRequiredSession(playerId) {
    const session = this.sessionRegistry.get(playerId)
    if (!session) {
      throw this._createError('SESSION_NOT_FOUND', '会话不存在，请重新连接')
    }

    return session
  }

  _getRoomAndPlayerByPlayerId(playerId) {
    const session = this._getRequiredSession(playerId)
    if (!session.roomId) {
      throw this._createError('ROOM_NOT_FOUND', '玩家当前不在任何房间中')
    }

    const room = this.rooms.get(session.roomId)
    if (!room) {
      session.roomId = null
      throw this._createError('ROOM_NOT_FOUND', '房间不存在')
    }

    const player = this._findPlayer(room, playerId)
    if (!player) {
      session.roomId = null
      throw this._createError('PLAYER_NOT_IN_ROOM', '玩家不在房间中')
    }

    return { room, player }
  }

  _findPlayer(room, playerId) {
    return room.players.find((item) => item.id === playerId) || null
  }

  _getOnlinePlayers(room) {
    if (!room) {
      return []
    }

    return room.players.filter((player) => !player.disconnected)
  }

  _refreshPresenceState(room) {
    if (!room) {
      return
    }

    if (this._getOnlinePlayers(room).length > 0) {
      room.allDisconnectedAt = null
    } else if (!room.allDisconnectedAt) {
      room.allDisconnectedAt = Date.now()
    }

    this._scheduleRoomIdleCheck(room)
  }

  _clearHostTransfer(room, playerId) {
    if (!room) {
      return
    }

    if (playerId && room.hostTransferPlayerId && room.hostTransferPlayerId !== playerId) {
      return
    }

    if (room.hostTransferTimer) {
      clearTimeout(room.hostTransferTimer)
      room.hostTransferTimer = null
    }
    room.hostTransferPlayerId = null
  }

  _transferHost(room, playerId) {
    const player = this._findPlayer(room, playerId)
    if (!room || !player || !player.isHost) {
      return false
    }

    const nextHost = room.players
      .slice()
      .filter((candidate) => candidate.id !== playerId && !candidate.disconnected)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0]

    if (!nextHost) {
      return false
    }

    this._clearHostTransfer(room)
    player.isHost = false
    nextHost.isHost = true
    this._markRoomActive(room)
    this.emit('room:hostTransferred', {
      roomId: room.id,
      player: this._toPublicPlayer(nextHost),
      previousPlayer: this._toPublicPlayer(player),
      roomState: this.getRoomState(room.id),
      reason: 'host_disconnect_timeout',
    })
    return true
  }

  _scheduleHostTransfer(room, playerId, delayMs) {
    this._clearHostTransfer(room)
    room.hostTransferPlayerId = playerId
    room.hostTransferTimer = setTimeout(() => {
      const latestRoom = this.rooms.get(room.id)
      if (!latestRoom) {
        return
      }

      this._transferHost(latestRoom, playerId)
      if (latestRoom && latestRoom.hostTransferPlayerId === playerId) {
        latestRoom.hostTransferPlayerId = null
      }
    }, delayMs)
    room.hostTransferTimer.unref()
  }

  _ensureHostTransfer(room) {
    if (!room) {
      return
    }

    const currentHost = room.players.find((player) => player.isHost) || null
    if (!currentHost || !currentHost.disconnected) {
      this._clearHostTransfer(room)
      return
    }

    const onlineCandidates = this._getOnlinePlayers(room).filter(
      (player) => player.id !== currentHost.id
    )
    if (!onlineCandidates.length) {
      this._clearHostTransfer(room, currentHost.id)
      return
    }

    const disconnectedFor = Date.now() - (currentHost.disconnectedAt || Date.now())
    if (disconnectedFor >= this.hostTransferGraceMs) {
      this._transferHost(room, currentHost.id)
      return
    }

    if (
      room.hostTransferTimer &&
      room.hostTransferPlayerId === currentHost.id
    ) {
      return
    }

    this._scheduleHostTransfer(
      room,
      currentHost.id,
      Math.max(this.hostTransferGraceMs - disconnectedFor, 0)
    )
  }

  _assertHost(player) {
    if (!player.isHost) {
      throw this._createError('HOST_ONLY_ACTION', '只有房主可以执行该操作')
    }
  }

  _assertGamePhase(room, allowedPhases) {
    if (!room.gameState || !allowedPhases.includes(room.gameState.phase)) {
      throw this._createError('INVALID_GAME_PHASE', '当前阶段无法执行该操作')
    }
  }

  _normalizeNickname(nickname) {
    const value = String(nickname || '').trim()
    if (value) {
      return value.slice(0, 20)
    }

    return `玩家${String(randomInt(1000, 10000))}`
  }

  _normalizeAvatar(avatar) {
    return String(avatar || '').trim()
  }

  _toPublicPlayer(player) {
    return stateProjection.toPublicPlayer(player)
  }

  _createError(code, message, details = {}) {
    const error = new Error(message)
    error.code = code
    error.details = details
    return error
  }
}

module.exports = RoomManager
