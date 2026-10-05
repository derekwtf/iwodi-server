const Dealer = require('./Dealer')

function createGameState({ players, spyCount, playMode, wordLibrary, usedPromptPairIds }) {
  const dealResult = Dealer.deal(players, spyCount, wordLibrary, usedPromptPairIds, playMode)
  return {
    ...dealResult,
    phase: 'dealing',
    playMode,
    playerRoster: players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      vipExpiresAt: player.vipExpiresAt,
      lastNormalAvatar: player.lastNormalAvatar,
      joinedAt: player.joinedAt,
      hasLeft: false,
      leftReason: null,
    })),
  }
}

module.exports = { createGameState }
