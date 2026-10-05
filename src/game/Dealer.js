function shuffle(list) {
  const result = [...list]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const current = result[index]
    result[index] = result[swapIndex]
    result[swapIndex] = current
  }

  return result
}

function deal(players, spyCount, wordLibrary, excludeKeys = [], playMode = 'language') {
  const playerIds = players.map((player) => player.id)
  const wordPair = wordLibrary.getRandomPair({ excludeKeys })
  if (!wordPair || typeof wordPair.civilian !== 'string' || !wordPair.civilian.trim() ||
    typeof wordPair.spy !== 'string' || !wordPair.spy.trim() || wordPair.civilian === wordPair.spy ||
    !wordPair.categoryId || !wordPair.groupId ||
    (playMode === 'body' && [wordPair.civilianSteps, wordPair.spySteps].some((steps) =>
      !Array.isArray(steps) || steps.length !== 2 || steps.some((step) => typeof step !== 'string' || !step.trim())))) {
    throw new Error('提示发牌失败，请稍后重试')
  }
  const selectedSpyIds = new Set(shuffle(playerIds).slice(0, spyCount))
  const roles = {}
  const playerWords = {}
  const playerPerformanceSteps = {}

  playerIds.forEach((playerId) => {
    const role = selectedSpyIds.has(playerId) ? 'spy' : 'civilian'
    roles[playerId] = role
    playerWords[playerId] = role === 'spy' ? wordPair.spy : wordPair.civilian
    playerPerformanceSteps[playerId] = playMode === 'body'
      ? [...(role === 'spy' ? wordPair.spySteps : wordPair.civilianSteps)] : null
  })

  return {
    promptPairKey: `${playMode}:${wordPair.categoryId}:${wordPair.groupId}`,
    historyReset: Boolean(wordPair.historyReset),
    wordPair: {
      civilian: wordPair.civilian,
      spy: wordPair.spy,
      groupId: wordPair.groupId,
      categoryId: wordPair.categoryId,
      categoryLabel: wordPair.categoryLabel,
    },
    roles,
    playerWords,
    playerPerformanceSteps,
  }
}

module.exports = {
  deal,
}
