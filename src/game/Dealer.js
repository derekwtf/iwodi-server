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

function deal(players, spyCount, wordLibrary, excludeIndices = []) {
  const playerIds = players.map((player) => player.id)
  const wordPair = wordLibrary.getRandomPair(excludeIndices)
  const selectedSpyIds = new Set(shuffle(playerIds).slice(0, spyCount))
  const roles = {}
  const playerWords = {}

  playerIds.forEach((playerId) => {
    const role = selectedSpyIds.has(playerId) ? 'spy' : 'civilian'
    roles[playerId] = role
    playerWords[playerId] = role === 'spy' ? wordPair.spy : wordPair.civilian
  })

  return {
    pairIndex: wordPair.index,
    wordPair: {
      civilian: wordPair.civilian,
      spy: wordPair.spy,
    },
    roles,
    playerWords,
  }
}

module.exports = {
  deal,
}
