const { resolveStoredProfile } = require('../user/profile')
const { getPlayRules } = require('./playMode')

function publicAppearance(player) {
  const { avatar, isVip } = resolveStoredProfile(player)
  return { avatar, isVip }
}

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

function getRoomState(room) {
  if (!room) return null
  const rules = getPlayRules(room.playMode)
  return {
    roomId: room.id,
    status: room.status,
    gamePhase: room.gameState ? room.gameState.phase : null,
    spyCount: room.spyCount,
    playMode: room.playMode,
    maxPlayers: rules.maxPlayers,
    minStartPlayers: rules.minPlayers,
    playerCount: room.players.length,
    players: room.players.slice().sort((left, right) => left.joinedAt - right.joinedAt).map(toPublicPlayer),
  }
}

function getGamePublicState(room) {
  if (!room || !room.gameState) return null
  const gameState = room.gameState
  return {
    roomId: room.id,
    phase: gameState.phase,
    playMode: gameState.playMode,
    wordCategoryLabel: gameState.wordPair.categoryLabel || '',
    players: gameState.playerRoster.slice().sort((left, right) => (left.joinedAt || 0) - (right.joinedAt || 0)).map((player) => {
      const livePlayer = room.players.find((item) => item.id === player.id)
      return {
        id: player.id,
        nickname: livePlayer ? livePlayer.nickname : player.nickname,
        ...publicAppearance(livePlayer || player),
        isHost: Boolean(livePlayer && livePlayer.isHost),
        disconnected: Boolean(livePlayer && livePlayer.disconnected),
        hasLeft: !livePlayer,
        leftReason: livePlayer ? null : player.leftReason,
      }
    }),
  }
}

function getReconnectGameSnapshot(room, playerId) {
  if (!room || !room.gameState || !room.players.some((player) => player.id === playerId)) return null
  const steps = room.gameState.playerPerformanceSteps[playerId]
  return {
    ...getGamePublicState(room),
    myWord: room.gameState.playerWords[playerId] || null,
    myRole: room.gameState.roles[playerId] || null,
    myPerformanceSteps: steps ? [...steps] : null,
  }
}

module.exports = { toPublicPlayer, getRoomState, getGamePublicState, getReconnectGameSnapshot }
