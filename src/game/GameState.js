const Dealer = require('./Dealer')
const SpeakOrder = require('./SpeakOrder')
const VoteManager = require('./VoteManager')
const Judge = require('./Judge')

function createGameState({ players, spyCount, gameMode, wordLibrary, usedWordPairIndices }) {
  const dealResult = Dealer.deal(players, spyCount, wordLibrary, usedWordPairIndices)
  const alivePlayers = players.map((player) => player.id)

  return {
    phase: 'dealing',
    round: 1,
    gameMode: gameMode || 'full',
    pairIndex: dealResult.pairIndex,
    wordPair: dealResult.wordPair,
    roles: dealResult.roles,
    playerWords: dealResult.playerWords,
    playerRoster: players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      joinedAt: player.joinedAt,
      hasLeft: false,
      leftReason: null,
      leftAtRound: null,
    })),
    alivePlayers,
    eliminatedPlayers: [],
    speakOrder: [],
    currentVotes: {},
    roundHistory: [],
    finalResult: null,
    confirmedPlayers: [],
    votedPlayers: [],
    currentResult: null,
  }
}

function confirmWord(gameState, playerId) {
  if (!gameState.confirmedPlayers.includes(playerId)) {
    gameState.confirmedPlayers.push(playerId)
  }

  return {
    confirmedPlayers: [...gameState.confirmedPlayers],
    allConfirmed: gameState.confirmedPlayers.length === gameState.alivePlayers.length,
  }
}

function startSpeaking(gameState) {
  gameState.phase = 'speaking'
  gameState.speakOrder = SpeakOrder.generateOrder(gameState.alivePlayers)
  gameState.currentVotes = {}
  gameState.votedPlayers = []
  gameState.currentResult = null
}

function startVoting(gameState) {
  gameState.phase = 'voting'
  gameState.currentVotes = {}
  gameState.votedPlayers = []
}

function finalizeVoting(gameState) {
  const voteResult = VoteManager.getResult(gameState)

  if (voteResult.eliminated) {
    gameState.alivePlayers = gameState.alivePlayers.filter(
      (playerId) => playerId !== voteResult.eliminated
    )
    if (!gameState.eliminatedPlayers.includes(voteResult.eliminated)) {
      gameState.eliminatedPlayers.push(voteResult.eliminated)
    }
  }

  const eliminatedRole = voteResult.eliminated
    ? gameState.roles[voteResult.eliminated]
    : null

  const roundRecord = {
    round: gameState.round,
    eliminated: voteResult.eliminated,
    role: eliminatedRole,
    votes: voteResult.votes,
  }

  gameState.roundHistory.push(roundRecord)

  const judgeResult = Judge.checkGameOver(gameState.alivePlayers, gameState.roles)
  if (judgeResult.gameOver) {
    gameState.phase = 'ended'
    gameState.finalResult = {
      winner: judgeResult.winner,
    }
  } else {
    gameState.phase = 'result'
  }

  gameState.currentResult = {
    round: gameState.round,
    isTie: voteResult.isTie,
    eliminated: voteResult.eliminated,
    eliminatedRole,
    eliminatedVotes: voteResult.eliminatedVotes,
    leaderboard: voteResult.leaderboard,
    votes: voteResult.votes,
    finalResult: gameState.finalResult,
  }

  return {
    roundRecord,
    currentResult: gameState.currentResult,
    finalResult: gameState.finalResult,
  }
}

function advanceToNextRound(gameState) {
  gameState.round += 1
  gameState.phase = 'speaking'
  gameState.speakOrder = SpeakOrder.generateOrder(gameState.alivePlayers)
  gameState.currentVotes = {}
  gameState.votedPlayers = []
  gameState.currentResult = null
}

module.exports = {
  createGameState,
  confirmWord,
  startSpeaking,
  startVoting,
  finalizeVoting,
  advanceToNextRound,
}
