const PLAYER_RULES = Object.freeze({ minPlayers: 3, maxPlayers: 12 })
const RULES = Object.freeze({ language: PLAYER_RULES, body: PLAYER_RULES })

function getPlayRules(playMode) {
  if (typeof playMode !== 'string' || !Object.prototype.hasOwnProperty.call(RULES, playMode)) {
    throw Object.assign(new Error('不支持的玩法模式'), { code: 'INVALID_PLAY_MODE' })
  }
  return RULES[playMode]
}

function getMaxSpyCount(playMode, playerCount) {
  getPlayRules(playMode)
  const ruleMax = playerCount >= 9 ? 3 : playerCount >= 6 ? 2 : 1
  return Math.max(1, Math.min(ruleMax, Math.floor(playerCount / 2) || 1))
}

function getDefaultSpyCount(playMode, playerCount) {
  getPlayRules(playMode)
  return playerCount >= 9 ? 2 : 1
}

module.exports = { getPlayRules, getMaxSpyCount, getDefaultSpyCount }
