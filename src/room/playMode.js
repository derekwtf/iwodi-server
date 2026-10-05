const RULES = Object.freeze({
  language: Object.freeze({ minPlayers: 4, maxPlayers: 12 }),
  body: Object.freeze({ minPlayers: 3, maxPlayers: 5 }),
})

function getPlayRules(playMode) {
  if (typeof playMode !== 'string' || !Object.prototype.hasOwnProperty.call(RULES, playMode)) {
    throw Object.assign(new Error('不支持的玩法模式'), { code: 'INVALID_PLAY_MODE' })
  }
  return RULES[playMode]
}

function getMaxSpyCount(playMode, playerCount) {
  getPlayRules(playMode)
  if (playMode === 'body') return 1
  const ruleMax = playerCount >= 9 ? 3 : playerCount >= 6 ? 2 : 1
  return Math.max(1, Math.min(ruleMax, Math.floor(playerCount / 2) || 1))
}

function getDefaultSpyCount(playMode, playerCount) {
  getPlayRules(playMode)
  return playMode === 'language' && playerCount >= 9 ? 2 : 1
}

module.exports = { getPlayRules, getMaxSpyCount, getDefaultSpyCount }
