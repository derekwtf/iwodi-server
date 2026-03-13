function submitVote(gameState, playerId, targetId) {
  gameState.currentVotes[playerId] = targetId === undefined ? null : targetId
  gameState.votedPlayers = gameState.alivePlayers.filter((alivePlayerId) =>
    Object.prototype.hasOwnProperty.call(gameState.currentVotes, alivePlayerId)
  )

  return {
    votedPlayers: [...gameState.votedPlayers],
    totalPlayers: gameState.alivePlayers.length,
  }
}

function isAllVoted(gameState) {
  return gameState.alivePlayers.every((playerId) =>
    Object.prototype.hasOwnProperty.call(gameState.currentVotes, playerId)
  )
}

function getResult(gameState) {
  const voteCounts = {}
  const votes = {}

  gameState.alivePlayers.forEach((playerId) => {
    const targetId = Object.prototype.hasOwnProperty.call(gameState.currentVotes, playerId)
      ? gameState.currentVotes[playerId]
      : null
    votes[playerId] = targetId === undefined ? null : targetId

    if (targetId) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1
    }
  })

  const leaderboard = Object.entries(voteCounts)
    .map(([playerId, voteCount]) => ({
      playerId,
      voteCount,
    }))
    .sort((left, right) => right.voteCount - left.voteCount)

  const topVoteCount = leaderboard[0] ? leaderboard[0].voteCount : 0
  const topCandidates = leaderboard.filter((item) => item.voteCount === topVoteCount)
  const isTie = topVoteCount > 0 && topCandidates.length > 1
  const eliminated = topVoteCount === 0 || isTie ? null : topCandidates[0].playerId

  return {
    leaderboard,
    isTie,
    eliminated,
    eliminatedVotes: eliminated ? topVoteCount : 0,
    votes,
  }
}

module.exports = {
  submitVote,
  isAllVoted,
  getResult,
}
