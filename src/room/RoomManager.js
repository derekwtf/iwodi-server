const { EventEmitter } = require('events')
const { randomInt } = require('crypto')
const GameState = require('../game/GameState')
const Judge = require('../game/Judge')
const VoteManager = require('../game/VoteManager')
const SessionRegistry = require('./SessionRegistry')
const stateProjection = require('./stateProjection')
const {
  normalizeGameMode,
  isDealOnlyMode,
  getMinStartPlayers,
} = require('./gameMode')

class RoomManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.rooms = new Map()
    this.sessionRegistry = new SessionRegistry()
    this.wordLibrary = options.wordLibrary || null
    this.maxPlayers = options.maxPlayers || 12
    const minStartPlayers = String(options.minStartPlayers ?? '').trim()
    this.minStartPlayers = /^(?:[2-9]|1[0-2])$/.test(minStartPlayers)
      ? Number(minStartPlayers)
      : 4
    this.hostTransferGraceMs = options.hostTransferGraceMs || 30 * 1000
    this.allDisconnectedTtlMs = options.allDisconnectedTtlMs || 10 * 60 * 1000
    this.waitingIdleMs = options.waitingIdleMs || 15 * 60 * 1000
    this.playingIdleMs = options.playingIdleMs || 10 * 60 * 1000
    this.endedIdleMs = options.endedIdleMs || 5 * 60 * 1000
    this.idleWarningMs = options.idleWarningMs || 60 * 1000
    this.voteReminderMs = options.voteReminderMs || 2 * 60 * 1000
    this.voteTimeoutMs = options.voteTimeoutMs || 3 * 60 * 1000
  }

  registerConnection({ playerId, socketId, identityKey }) {
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
      idleTimer: null,
      idleWarningTimer: null,
      hostTransferTimer: null,
      hostTransferPlayerId: null,
      allDisconnectedAt: null,
      lastActivityAt: now,
      lastHeartbeatAt: now,
      usedWordGroupIndices: [],
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

    const player = this._buildPlayer({
      playerId,
      nickname,
      avatar,
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

  updatePlayerProfile(playerId, { nickname, avatar } = {}) {
    const { room, player } = this._getRoomAndPlayerByPlayerId(playerId)
    const nextNickname = String(nickname || '').trim()
      ? this._normalizeNickname(nickname)
      : player.nickname
    const nextAvatar = avatar === undefined
      ? player.avatar
      : this._normalizeAvatar(avatar)

    player.nickname = nextNickname
    player.avatar = nextAvatar
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

    const minStartPlayers = getMinStartPlayers(room.gameMode, this.minStartPlayers)
    if (room.players.length < minStartPlayers) {
      throw this._createError('NOT_ENOUGH_PLAYERS', `至少需要 ${minStartPlayers} 人才能开始游戏`)
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
    return stateProjection.getRoomState(
      this.rooms.get(roomId), this.maxPlayers, this.minStartPlayers
    )
  }

  getGamePublicState(roomId, options = {}) {
    return stateProjection.getGamePublicState(this.rooms.get(roomId), options)
  }

  getReconnectGameSnapshot(roomId, playerId) {
    return stateProjection.getReconnectGameSnapshot(this.rooms.get(roomId), playerId)
  }

  getEndedPayload(roomId) {
    return stateProjection.getEndedPayload(
      this.rooms.get(roomId), this.maxPlayers, this.minStartPlayers
    )
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

  _assertAlivePlayer(room, playerId) {
    if (!room.gameState.alivePlayers.includes(playerId)) {
      throw this._createError('PLAYER_ALREADY_OUT', '当前玩家已被淘汰')
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
