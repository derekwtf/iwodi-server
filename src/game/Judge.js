function checkGameOver(alivePlayers, roles) {
  const spyCount = alivePlayers.filter((playerId) => roles[playerId] === 'spy').length
  const civilianCount = alivePlayers.length - spyCount

  if (spyCount === 0) {
    return {
      gameOver: true,
      winner: 'civilian',
    }
  }

  if (spyCount >= civilianCount) {
    return {
      gameOver: true,
      winner: 'spy',
    }
  }

  return {
    gameOver: false,
    winner: null,
  }
}

module.exports = {
  checkGameOver,
}
