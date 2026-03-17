const GAME_MODE_FULL = 'full'
const GAME_MODE_DEAL_ONLY = 'deal-only'

function normalizeGameMode(gameMode) {
  return gameMode === GAME_MODE_DEAL_ONLY ? GAME_MODE_DEAL_ONLY : GAME_MODE_FULL
}

function isDealOnlyMode(gameMode) {
  return normalizeGameMode(gameMode) === GAME_MODE_DEAL_ONLY
}

module.exports = {
  GAME_MODE_FULL,
  GAME_MODE_DEAL_ONLY,
  normalizeGameMode,
  isDealOnlyMode,
}
