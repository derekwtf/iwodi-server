function generateOrder(alivePlayers) {
  if (!Array.isArray(alivePlayers) || !alivePlayers.length) {
    return []
  }

  const firstSpeakerIndex = Math.floor(Math.random() * alivePlayers.length)
  return [alivePlayers[firstSpeakerIndex]]
}

module.exports = {
  generateOrder,
}
