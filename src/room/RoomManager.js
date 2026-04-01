const { EventEmitter } = require('events')
const { randomInt, randomUUID } = require('crypto')
const GameState = require('../game/GameState')
const Judge = require('../game/Judge')
const VoteManager = require('../game/VoteManager')
const {
  GAME_MODE_FULL,
  normalizeGameMode,
  isDealOnlyMode,
} = require('./gameMode')

class RoomManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.rooms = new Map()
    this.sessions = new Map()
    this.socketToPlayer = new Map()
    this.wordLibrary = options.wordLibrary || null
    this.maxPlayers = options.maxPlayers || 12
    this.disconnectGraceMs = options.disconnectGraceMs || 30 * 1000
    this.emptyRoomTtlMs = options.emptyRoomTtlMs || 5 * 60 * 1000
    this.waitingIdleMs = options.waitingIdleMs || 15 * 60 * 1000
    this.playingIdleMs = options.playingIdleMs || 10 * 60 * 1000
    this.endedIdleMs = options.endedIdleMs || 5 * 60 * 1000
    this.idleWarningMs = options.idleWarningMs || 60 * 1000
    this.voteReminderMs = options.voteReminderMs || 2 * 60 * 1000
    this.voteTimeoutMs = options.voteTimeoutMs || 3 * 60 * 1000
  }

  registerConnection({ playerId, socketId }) {
    let session = playerId ? this.sessions.get(playerId) : null
    let reconnectEvent = null

    if (!session) {
      session = this._createSession()
      if (playerId) {
        reconnectEvent = {
          event: 'reconnect:expired',
          payload: {
            reason: 'session_not_found',
            previousPlayerId: playerId,
          },
        }
      }
    }

    if (session.socketId && session.socketId !== socketId) {
      this.socketToPlayer.delete(session.socketId)
    }

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer)
      session.disconnectTimer = null
    }

    session.socketId = socketId
    session.lastSeenAt = Date.now()
    this.socketToPlayer.set(socketId, session.playerId)

    const room = session.roomId ? this.rooms.get(session.roomId) : null
    if (room) {
      const player = this._findPlayer(room, session.playerId)
      if (player) {
        player.disconnected = false
        player.disconnectedAt = null
      }

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
      reconnectEvent,
    }
  }

  getPlayerIdBySocketId(socketId) {
    return this.socketToPlayer.get(socketId) || null
  }

  getRoomIdForPlayer(playerId) {
    const session = this.sessions.get(playerId)
    return session ? session.roomId : null
  }

  getActiveSocketId(playerId) {
    const session = this.sessions.get(playerId)
    return session ? session.socketId : null
  }

  createRoom({ playerId, nickname, avatar, gameMode }) {
    const session = this._getRequiredSession(playerId)

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
          avatar,
          isHost: true,
        }),
      ],
      spyCount: 1,
      gameMode: normalizeGameMode(gameMode),
      status: 'waiting',
      gameState: null,
      createdAt: Date.now(),
      spyCountManual: false,
      emptyRoomTimer: null,
      idleTimer: null,
      idleWarningTimer: null,
      lastActivityAt: now,
      lastHeartbeatAt: now,
      usedWordGroupIndices: [],
    }

    session.roomId = room.id
    session.profile = this._normalizeProfile({ nickname, avatar })

    this.rooms.set(room.id, room)
    this._refreshSpyCount(room)
    this._markRoomActive(room)

    return {
      room,
      player: this._toPublicPlayer(room.players[0]),
      previousRoomResult,
    }
  }

  joinRoom(roomId, { playerId, nickname, avatar }) {
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
      existingPlayer.disconnected = false
      existingPlayer.disconnectedAt = null
      session.roomId = room.id
      session.profile = this._normalizeProfile({ nickname, avatar })
      this._markRoomActive(room)

      return {
        room,
        player: this._toPublicPlayer(existingPlayer),
        alreadyInRoom: true,
      }
    }

    if (room.players.length >= this.maxPlayers) {
      throw this._createError('ROOM_FULL', '房间已满，无法加入')
    }

    let previousRoomResult = null
    if (session.roomId && session.roomId !== room.id) {
      previousRoomResult = this.leaveRoom(session.roomId, playerId, {
        reason: 'switch_room',
      })
    }

    this._clearRoomCleanup(room)

    const player = this._buildPlayer({
      playerId,
      nickname,
      avatar,
      isHost: room.players.length === 0,
    })

    room.players.push(player)
    session.roomId = room.id
    session.profile = this._normalizeProfile({ nickname, avatar })
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
    const session = this.sessions.get(playerId)
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
    const session = this.sessions.get(playerId)

    if (!room || !session) {
      return null
    }

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer)
      session.disconnectTimer = null
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
      this._refreshSpyCount(room)
      this._markRoomActive(room)
    }

    return {
      roomId: room.id,
      roomState: this.getRoomState(room.id),
      removedPlayer: this._toPublicPlayer(removedPlayer),
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

    const maxSpyCount = this._getMaxSpyCount(room.players.length)
    const nextSpyCount = Math.max(1, Math.min(maxSpyCount, Number(requestedCount) || 1))

    room.spyCount = nextSpyCount
    room.spyCountManual = true
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      spyCount: room.spyCount,
    }
  }

  setGameMode(playerId, requestedMode) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)
    if (room.status !== 'waiting') {
      throw this._createError('GAME_ALREADY_STARTED', '游戏已开始，无法调整游戏模式')
    }

    room.gameMode = normalizeGameMode(requestedMode)
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      gameMode: room.gameMode,
    }
  }

  updatePlayerProfile(playerId, { nickname, avatar } = {}) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    const session = this._getRequiredSession(playerId)
    const nextNickname = String(nickname || '').trim()
      ? this._normalizeNickname(nickname)
      : player.nickname
    const nextAvatar = avatar === undefined
      ? player.avatar
      : this._normalizeAvatar(avatar)

    player.nickname = nextNickname
    player.avatar = nextAvatar
    session.profile = {
      nickname: nextNickname,
      avatar: nextAvatar,
    }

    if (room.gameState && Array.isArray(room.gameState.playerRoster)) {
      const rosterPlayer = room.gameState.playerRoster.find((item) => item.id === playerId)
      if (rosterPlayer) {
        rosterPlayer.nickname = nextNickname
        rosterPlayer.avatar = nextAvatar
      }
    }

    this._markRoomActive(room)

    return {
      room,
      player: this._toPublicPlayer(player),
      roomState: this.getRoomState(room.id),
      gameState: room.gameState
        ? this.getGamePublicState(room.id, {
            includeEndedSecrets: room.gameState.phase === 'ended',
          })
        : null,
    }
  }

  startGame(playerId) {
    if (!this.wordLibrary) {
      throw this._createError('WORD_LIBRARY_NOT_READY', '词库未加载，无法开始游戏')
    }

    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)

    if (room.status !== 'waiting') {
      throw this._createError('GAME_ALREADY_STARTED', '当前房间已开始游戏')
    }

    if (room.players.length < 4) {
      throw this._createError('NOT_ENOUGH_PLAYERS', '至少需要 4 人才能开始游戏')
    }

    room.gameState = GameState.createGameState({
      players: room.players,
      spyCount: room.spyCount,
      gameMode: room.gameMode,
      wordLibrary: this.wordLibrary,
      usedWordGroupIndices: room.usedWordGroupIndices,
    })
    room.status = 'playing'
    room.usedWordGroupIndices.push(room.gameState.wordGroupIndex)
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
    }
  }

  confirmWord(playerId) {
    const { room } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertGamePhase(room, ['dealing'])
    this._assertAlivePlayer(room, playerId)

    if (isDealOnlyMode(room.gameMode)) {
      throw this._createError('GAME_CONFIRM_DISABLED', '仅发牌模式无需确认')
    }

    const progress = GameState.confirmWord(room.gameState, playerId)
    let speakingState = null

    if (progress.allConfirmed) {
      GameState.startSpeaking(room.gameState)
      speakingState = this.getGamePublicState(room.id)
    }
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      confirmedPlayers: [...room.gameState.confirmedPlayers],
      confirmedCount: room.gameState.confirmedPlayers.length,
      totalPlayers: room.gameState.alivePlayers.length,
      allConfirmed: progress.allConfirmed,
      speakingState,
    }
  }

  startVote(playerId) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)
    this._assertGamePhase(room, ['speaking'])

    GameState.startVoting(room.gameState)
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      publicState: this.getGamePublicState(room.id),
    }
  }

  submitVote(playerId, targetId) {
    const { room } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertGamePhase(room, ['voting'])
    this._assertAlivePlayer(room, playerId)

    const normalizedTargetId =
      targetId === null || targetId === undefined || targetId === ''
        ? null
        : String(targetId)

    if (normalizedTargetId === playerId) {
      throw this._createError('VOTE_SELF_NOT_ALLOWED', '不能给自己投票')
    }

    if (
      normalizedTargetId &&
      !room.gameState.alivePlayers.includes(normalizedTargetId)
    ) {
      throw this._createError('VOTE_TARGET_INVALID', '只能投给存活玩家')
    }

    const voteProgress = VoteManager.submitVote(
      room.gameState,
      playerId,
      normalizedTargetId
    )
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      votedPlayers: voteProgress.votedPlayers,
      totalPlayers: voteProgress.totalPlayers,
      allVoted: VoteManager.isAllVoted(room.gameState),
    }
  }

  getPendingVoters(roomId) {
    const room = this.rooms.get(roomId)
    if (!room || !room.gameState || room.gameState.phase !== 'voting') {
      return []
    }

    return room.gameState.alivePlayers.filter(
      (playerId) =>
        !Object.prototype.hasOwnProperty.call(room.gameState.currentVotes, playerId)
    )
  }

  completeVoteTimeout(roomId) {
    const room = this.rooms.get(roomId)
    if (!room || !room.gameState || room.gameState.phase !== 'voting') {
      return null
    }

    this.getPendingVoters(roomId).forEach((playerId) => {
      room.gameState.currentVotes[playerId] = null
    })
    room.gameState.votedPlayers = [...room.gameState.alivePlayers]

    return this.finalizeVoting(roomId)
  }

  finalizeVoting(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) {
      throw this._createError('ROOM_NOT_FOUND', '房间不存在')
    }

    this._assertGamePhase(room, ['voting'])
    GameState.finalizeVoting(room.gameState)

    room.status = room.gameState.phase === 'ended' ? 'ended' : 'playing'
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
      publicState: this.getGamePublicState(room.id),
      endedPayload:
        room.gameState.phase === 'ended' ? this.getEndedPayload(room.id) : null,
    }
  }

  continueGame(playerId) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)

    if (room.gameState.phase === 'result') {
      GameState.advanceToNextRound(room.gameState)
      room.status = 'playing'
      this._markRoomActive(room)

      return {
        type: 'nextRound',
        room,
        roomState: this.getRoomState(room.id),
        publicState: this.getGamePublicState(room.id),
      }
    }

    if (room.gameState.phase === 'ended') {
      room.status = 'ended'
      this._markRoomActive(room)

      return {
        type: 'ended',
        room,
        roomState: this.getRoomState(room.id),
        endedPayload: this.getEndedPayload(room.id),
      }
    }

    throw this._createError('INVALID_GAME_PHASE', '当前阶段无法继续')
  }

  restartGame(playerId) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    this._assertHost(player)
    this._assertGamePhase(
      room,
      isDealOnlyMode(room.gameMode) ? ['dealing', 'ended'] : ['ended']
    )

    room.status = 'waiting'
    room.gameState = null
    this._markRoomActive(room)

    return {
      room,
      roomState: this.getRoomState(room.id),
    }
  }

  markDisconnected(socketId) {
    const playerId = this.socketToPlayer.get(socketId)
    if (!playerId) {
      return null
    }

    this.socketToPlayer.delete(socketId)

    const session = this.sessions.get(playerId)
    if (!session) {
      return null
    }

    if (session.socketId === socketId) {
      session.socketId = null
    }

    if (!session.roomId) {
      return null
    }

    const room = this.rooms.get(session.roomId)
    if (!room) {
      session.roomId = null
      return null
    }

    const player = this._findPlayer(room, playerId)
    if (!player) {
      session.roomId = null
      return null
    }

    player.disconnected = true
    player.disconnectedAt = Date.now()

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer)
    }

    session.disconnectTimer = setTimeout(() => {
      session.disconnectTimer = null
      const result = this.leaveRoom(room.id, playerId, {
        reason: 'disconnect_timeout',
      })

      this.emit('player:disconnectTimeout', {
        playerId,
        ...result,
      })
    }, this.disconnectGraceMs)

    return {
      playerId,
      roomId: room.id,
      player: this._toPublicPlayer(player),
      roomState: this.getRoomState(room.id),
      graceMs: this.disconnectGraceMs,
    }
  }

  abandonReconnect(playerId) {
    return this.leaveRoomByPlayerId(playerId, {
      reason: 'reconnect_abandon',
    })
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
    const room = this.rooms.get(roomId)
    if (!room) {
      return null
    }

    return {
      roomId: room.id,
      status: room.status,
      gamePhase: room.gameState ? room.gameState.phase : null,
      round: room.gameState ? room.gameState.round : null,
      spyCount: room.spyCount,
      gameMode: room.gameMode || GAME_MODE_FULL,
      maxPlayers: this.maxPlayers,
      playerCount: room.players.length,
      players: room.players
        .slice()
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .map((player) => this._toPublicPlayer(player)),
    }
  }

  getGamePublicState(roomId, options = {}) {
    const room = this.rooms.get(roomId)
    if (!room || !room.gameState) {
      return null
    }

    const { includeEndedSecrets = false } = options
    const publicState = {
      roomId: room.id,
      phase: room.gameState.phase,
      round: room.gameState.round,
      gameMode: room.gameMode || GAME_MODE_FULL,
      wordCategoryLabel: room.gameState.wordPair
        ? room.gameState.wordPair.categoryLabel || ''
        : '',
      players: this._getGamePlayersForPublicState(room),
      alivePlayers: [...room.gameState.alivePlayers],
      eliminatedPlayers: [...room.gameState.eliminatedPlayers],
      speakOrder: [...room.gameState.speakOrder],
      roundHistory: room.gameState.roundHistory.map((item) => ({
        round: item.round,
        eliminated: item.eliminated,
        role: item.role,
        votes: { ...item.votes },
      })),
      confirmedPlayers:
        room.gameState.phase === 'dealing'
          ? [...room.gameState.confirmedPlayers]
          : [],
      votedPlayers:
        room.gameState.phase === 'voting'
          ? [...room.gameState.votedPlayers]
          : [],
      currentResult: room.gameState.currentResult
        ? {
            ...room.gameState.currentResult,
            votes: { ...room.gameState.currentResult.votes },
            leaderboard: room.gameState.currentResult.leaderboard.map((item) => ({
              ...item,
            })),
          }
        : null,
      finalResult: room.gameState.finalResult
        ? { ...room.gameState.finalResult }
        : null,
    }

    if (includeEndedSecrets && room.gameState.phase === 'ended') {
      publicState.roles = { ...room.gameState.roles }
      publicState.wordPair = { ...room.gameState.wordPair }
    }

    return publicState
  }

  getReconnectGameSnapshot(roomId, playerId) {
    const room = this.rooms.get(roomId)
    if (!room || !room.gameState) {
      return null
    }

    const snapshot = this.getGamePublicState(roomId, {
      includeEndedSecrets: room.gameState.phase === 'ended',
    })

    snapshot.myWord = room.gameState.playerWords[playerId] || null
    snapshot.myRole = room.gameState.roles[playerId] || null
    return snapshot
  }

  getEndedPayload(roomId) {
    const room = this.rooms.get(roomId)
    if (!room || !room.gameState || room.gameState.phase !== 'ended') {
      return null
    }

    return {
      ...this.getGamePublicState(roomId, {
        includeEndedSecrets: true,
      }),
      room: this.getRoomState(roomId),
    }
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) {
      return false
    }

    this._clearRoomCleanup(room)
    this._clearRoomIdleTimers(room)
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
      const session = this.sessions.get(player.id)
      if (!session) {
        return
      }

      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer)
        session.disconnectTimer = null
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

  _createSession() {
    const playerId = randomUUID()
    const session = {
      playerId,
      socketId: null,
      roomId: null,
      disconnectTimer: null,
      lastSeenAt: Date.now(),
      profile: {
        nickname: '',
        avatar: '',
      },
    }

    this.sessions.set(playerId, session)
    return session
  }

  _buildPlayer({ playerId, nickname, avatar, isHost }) {
    return {
      id: playerId,
      nickname: this._normalizeNickname(nickname),
      avatar: this._normalizeAvatar(avatar),
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
    const maxSpyCount = this._getMaxSpyCount(room.players.length)
    if (!room.spyCountManual) {
      room.spyCount = this._getDefaultSpyCount(room.players.length)
      return
    }

    room.spyCount = Math.max(1, Math.min(maxSpyCount, room.spyCount))
  }

  _getDefaultSpyCount(playerCount) {
    if (playerCount >= 9) {
      return 2
    }

    return 1
  }

  _getMaxSpyCount(playerCount) {
    const ruleMax = playerCount >= 9 ? 3 : playerCount >= 6 ? 2 : 1
    return Math.max(1, Math.min(ruleMax, Math.floor(playerCount / 2) || 1))
  }

  _removePlayerFromGameState(room, playerId, reason) {
    if (!room.gameState) {
      return
    }

    room.gameState.alivePlayers = room.gameState.alivePlayers.filter(
      (item) => item !== playerId
    )
    room.gameState.eliminatedPlayers = room.gameState.eliminatedPlayers.filter(
      (item) => item !== playerId
    )
    room.gameState.speakOrder = room.gameState.speakOrder.filter(
      (item) => item !== playerId
    )
    room.gameState.confirmedPlayers = room.gameState.confirmedPlayers.filter(
      (item) => item !== playerId
    )
    room.gameState.votedPlayers = room.gameState.votedPlayers.filter(
      (item) => item !== playerId
    )

    const nextVotes = {}
    Object.entries(room.gameState.currentVotes || {}).forEach(([voterId, targetId]) => {
      if (voterId === playerId) {
        return
      }
      nextVotes[voterId] = targetId === playerId ? null : targetId
    })
    room.gameState.currentVotes = nextVotes

    const rosterPlayer = (room.gameState.playerRoster || []).find(
      (item) => item.id === playerId
    )
    if (rosterPlayer) {
      rosterPlayer.hasLeft = true
      rosterPlayer.leftReason = reason || 'leave'
      rosterPlayer.leftAtRound = room.gameState.round
    }
  }

  _resolveGameStateAfterLeave(room) {
    if (!room.gameState || room.players.length === 0) {
      return null
    }

    const judgeResult = Judge.checkGameOver(
      room.gameState.alivePlayers,
      room.gameState.roles
    )
    if (judgeResult.gameOver) {
      room.gameState.phase = 'ended'
      room.gameState.finalResult = {
        winner: judgeResult.winner,
      }
      room.status = 'ended'

      return {
        type: 'ended',
        payload: this.getEndedPayload(room.id),
      }
    }

    if (room.gameState.phase === 'dealing') {
      if (isDealOnlyMode(room.gameMode)) {
        return {
          type: 'stateSync',
          payload: this.getGamePublicState(room.id),
        }
      }

      if (
        room.gameState.confirmedPlayers.length === room.gameState.alivePlayers.length &&
        room.gameState.alivePlayers.length > 0
      ) {
        GameState.startSpeaking(room.gameState)
        room.status = 'playing'

        return {
          type: 'speakingStarted',
          payload: this.getGamePublicState(room.id),
        }
      }

      return {
        type: 'stateSync',
        payload: this.getGamePublicState(room.id),
      }
    }

    if (room.gameState.phase === 'voting') {
      if (VoteManager.isAllVoted(room.gameState)) {
        GameState.finalizeVoting(room.gameState)
        room.status = room.gameState.phase === 'ended' ? 'ended' : 'playing'

        if (room.gameState.phase === 'ended') {
          return {
            type: 'ended',
            payload: this.getEndedPayload(room.id),
          }
        }

        return {
          type: 'result',
          payload: this.getGamePublicState(room.id),
        }
      }

      return {
        type: 'stateSync',
        payload: this.getGamePublicState(room.id),
      }
    }

    if (room.gameState.phase === 'ended') {
      room.status = 'ended'
      return {
        type: 'ended',
        payload: this.getEndedPayload(room.id),
      }
    }

    room.status = room.gameState.phase === 'result' ? 'playing' : room.status

    return {
      type: 'stateSync',
      payload: this.getGamePublicState(room.id),
    }
  }

  _getGamePlayersForPublicState(room) {
    const livePlayers = room.players.reduce((result, player) => {
      result[player.id] = player
      return result
    }, {})
    const eliminatedRoundMap = (room.gameState.roundHistory || []).reduce(
      (result, item) => {
        if (item.eliminated && !result[item.eliminated]) {
          result[item.eliminated] = item.round
        }
        return result
      },
      {}
    )
    const sourcePlayers = room.gameState.playerRoster || room.players

    return sourcePlayers
      .slice()
      .sort((left, right) => (left.joinedAt || 0) - (right.joinedAt || 0))
      .map((player) => {
        const livePlayer = livePlayers[player.id]
        return {
          id: player.id,
          nickname: livePlayer ? livePlayer.nickname : player.nickname,
          avatar: livePlayer ? livePlayer.avatar : player.avatar,
          isHost: Boolean(livePlayer && livePlayer.isHost),
          disconnected: Boolean(livePlayer && livePlayer.disconnected),
          hasLeft: Boolean(!livePlayer && player.hasLeft),
          leftReason: !livePlayer ? player.leftReason || null : null,
          eliminatedRound: eliminatedRoundMap[player.id] || null,
        }
      })
  }

  _scheduleRoomCleanup(room) {
    this._clearRoomCleanup(room)
    room.emptyRoomTimer = setTimeout(() => {
      const latestRoom = this.rooms.get(room.id)
      if (latestRoom && latestRoom.players.length === 0) {
        this.destroyRoom(room.id)
      }
    }, this.emptyRoomTtlMs)
  }

  _clearRoomCleanup(room) {
    if (room.emptyRoomTimer) {
      clearTimeout(room.emptyRoomTimer)
      room.emptyRoomTimer = null
    }
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
    this._scheduleRoomIdleCheck(room)
  }

  _getRoomIdlePolicy(room) {
    if (!room || room.players.length === 0) {
      return null
    }

    if (room.status === 'waiting') {
      return {
        ttlMs: this.waitingIdleMs,
        baseAt: room.lastActivityAt || room.createdAt || Date.now(),
        reason: 'waiting_idle_timeout',
      }
    }

    if (room.status === 'ended') {
      return {
        ttlMs: this.endedIdleMs,
        baseAt: room.lastActivityAt || room.createdAt || Date.now(),
        reason: 'ended_idle_timeout',
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
    const session = this.sessions.get(playerId)
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

  _assertAlivePlayer(room, playerId) {
    if (!room.gameState.alivePlayers.includes(playerId)) {
      throw this._createError('PLAYER_ALREADY_OUT', '当前玩家已被淘汰')
    }
  }

  _normalizeProfile({ nickname, avatar }) {
    return {
      nickname: this._normalizeNickname(nickname),
      avatar: this._normalizeAvatar(avatar),
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
    return {
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      isReady: player.isReady,
      isHost: player.isHost,
      disconnected: player.disconnected,
    }
  }

  _createError(code, message, details = {}) {
    const error = new Error(message)
    error.code = code
    error.details = details
    return error
  }
}

module.exports = RoomManager
