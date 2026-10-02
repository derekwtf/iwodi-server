const { AVATARS, VIP_AVATARS } = require('../user/profile')

function publicAppearance(player) {
  const isVip = Date.now() < (player.vipExpiresAt || 0)
  const avatar = !isVip && VIP_AVATARS.has(player.avatar)
    ? (AVATARS.has(player.lastNormalAvatar) ? player.lastNormalAvatar : '/assets/avatars/avatar-1.svg')
    : player.avatar
  return { avatar, isVip }
}

const { GAME_MODE_FULL, getMinStartPlayers } = require('./gameMode')

function toPublicPlayer(player) {
  return {
    id: player.id,
    nickname: player.nickname,
    ...publicAppearance(player),
    isReady: player.isReady,
    isHost: player.isHost,
    disconnected: player.disconnected,
  }
}

function getRoomState(room, maxPlayers, configuredMinStartPlayers) {
  if (!room) return null
  return {
    roomId: room.id,
    status: room.status,
    gamePhase: room.gameState ? room.gameState.phase : null,
    round: room.gameState ? room.gameState.round : null,
    spyCount: room.spyCount,
    gameMode: room.gameMode || GAME_MODE_FULL,
    maxPlayers,
    minStartPlayers: getMinStartPlayers(room.gameMode, configuredMinStartPlayers),
    playerCount: room.players.length,
    players: room.players
      .slice()
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map(toPublicPlayer),
  }
}

function getGamePlayers(room) {
  const livePlayers = room.players.reduce((result, player) => {
    result[player.id] = player
    return result
  }, {})
  const eliminatedRoundMap = (room.gameState.roundHistory || []).reduce((result, item) => {
    if (item.eliminated && !result[item.eliminated]) {
      result[item.eliminated] = item.round
    }
    return result
  }, {})
  const sourcePlayers = room.gameState.playerRoster || room.players

  return sourcePlayers
    .slice()
    .sort((left, right) => (left.joinedAt || 0) - (right.joinedAt || 0))
    .map((player) => {
      const livePlayer = livePlayers[player.id]
      return {
        id: player.id,
        nickname: livePlayer ? livePlayer.nickname : player.nickname,
        ...publicAppearance(livePlayer || player),
        isHost: Boolean(livePlayer && livePlayer.isHost),
        disconnected: Boolean(livePlayer && livePlayer.disconnected),
        hasLeft: Boolean(!livePlayer && player.hasLeft),
        leftReason: !livePlayer ? player.leftReason || null : null,
        eliminatedRound: eliminatedRoundMap[player.id] || null,
      }
    })
}

function getGamePublicState(room, { includeEndedSecrets = false } = {}) {
  if (!room || !room.gameState) return null
  const gameState = room.gameState
  const publicState = {
    roomId: room.id,
    phase: gameState.phase,
    round: gameState.round,
    gameMode: room.gameMode || GAME_MODE_FULL,
    wordCategoryLabel: gameState.wordPair
      ? gameState.wordPair.categoryLabel || ''
      : '',
    players: getGamePlayers(room),
    alivePlayers: [...gameState.alivePlayers],
    eliminatedPlayers: [...gameState.eliminatedPlayers],
    speakOrder: [...gameState.speakOrder],
    roundHistory: gameState.roundHistory.map((item) => ({
      round: item.round,
      eliminated: item.eliminated,
      role: item.role,
      votes: { ...item.votes },
    })),
    confirmedPlayers: gameState.phase === 'dealing' ? [...gameState.confirmedPlayers] : [],
    votedPlayers: gameState.phase === 'voting' ? [...gameState.votedPlayers] : [],
    currentResult: gameState.currentResult
      ? {
          ...gameState.currentResult,
          votes: { ...gameState.currentResult.votes },
          leaderboard: gameState.currentResult.leaderboard.map((item) => ({ ...item })),
        }
      : null,
    finalResult: gameState.finalResult ? { ...gameState.finalResult } : null,
  }

  if (includeEndedSecrets && gameState.phase === 'ended') {
    publicState.roles = { ...gameState.roles }
    publicState.wordPair = { ...gameState.wordPair }
  }
  return publicState
}

function getReconnectGameSnapshot(room, playerId) {
  if (!room || !room.gameState) return null
  return {
    ...getGamePublicState(room, { includeEndedSecrets: room.gameState.phase === 'ended' }),
    myWord: room.gameState.playerWords[playerId] || null,
    myRole: room.gameState.roles[playerId] || null,
  }
}

function getEndedPayload(room, maxPlayers, configuredMinStartPlayers) {
  if (!room || !room.gameState || room.gameState.phase !== 'ended') return null
  return {
    ...getGamePublicState(room, { includeEndedSecrets: true }),
    room: getRoomState(room, maxPlayers, configuredMinStartPlayers),
  }
}

module.exports = {
  toPublicPlayer,
  getRoomState,
  getGamePublicState,
  getReconnectGameSnapshot,
  getEndedPayload,
}
