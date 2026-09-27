const GAME_MODE_FULL = 'full'
const GAME_MODE_DEAL_ONLY = 'deal-only'

function normalizeGameMode(gameMode) {
  return gameMode === GAME_MODE_DEAL_ONLY ? GAME_MODE_DEAL_ONLY : GAME_MODE_FULL
}

function isDealOnlyMode(gameMode) {
  return normalizeGameMode(gameMode) === GAME_MODE_DEAL_ONLY
}

function getMinStartPlayers(gameMode, configuredMinStartPlayers) {
  return isDealOnlyMode(gameMode)
    ? configuredMinStartPlayers
    : Math.max(configuredMinStartPlayers, 3)
}

module.exports = {
  GAME_MODE_FULL,
  GAME_MODE_DEAL_ONLY,
  normalizeGameMode,
  isDealOnlyMode,
  getMinStartPlayers,
}
