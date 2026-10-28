const { randomInt } = require('crypto')

const AVATAR_COUNT = 8
const AVATARS = new Set(Array.from({ length: AVATAR_COUNT }, (_, index) =>
  `/assets/avatars/avatar-${index + 1}.svg`))
const VIP_AVATARS = new Set(Array.from({ length: 20 }, (_, index) =>
  `/assets/avatars/avatar-${index + 9}.svg`))

function normalizeProfile({ nickname, avatar } = {}, isVip = false) {
  const normalized = typeof nickname === 'string' ? nickname.trim().slice(0, 20) : ''
  if (!normalized) {
    throw Object.assign(new Error('请输入昵称'), { code: 'INVALID_NICKNAME' })
  }
  if (!AVATARS.has(avatar) && !(isVip && VIP_AVATARS.has(avatar))) {
    throw Object.assign(new Error('请选择可用头像，9～28 号仅限有效 VIP'), { code: 'INVALID_AVATAR' })
  }
  return { nickname: normalized, avatar }
}

function resolveStoredProfile(profile, now = Date.now()) {
  if (!profile) return profile
  const vipExpiresAt = profile.vipExpiresAt || 0
  const isVip = now < vipExpiresAt
  const lastNormalAvatar = AVATARS.has(profile.lastNormalAvatar)
    ? profile.lastNormalAvatar : '/assets/avatars/avatar-1.svg'
  const avatar = AVATARS.has(profile.avatar) || (isVip && VIP_AVATARS.has(profile.avatar))
    ? profile.avatar : lastNormalAvatar
  return { ...profile, avatar, lastNormalAvatar: AVATARS.has(avatar) ? avatar : lastNormalAvatar,
    vipExpiresAt, isVip }
}

function getUserState(user, product = {}) {
  return {
    userId: user.userId,
    ...(user.accountType ? { accountType: user.accountType } : {}),
    profile: { nickname: user.nickname, avatar: user.avatar },
    membership: {
      isVip: user.isVip,
      vipExpiresAt: user.vipExpiresAt,
      availableAvatars: [...AVATARS, ...(user.isVip ? VIP_AVATARS : [])],
      vipAvatars: [...VIP_AVATARS],
      durationDays: 30,
      productId: 'vip_month',
      priceFen: 1000,
      purchasable: false,
      ...product,
      serverTime: Date.now(),
    },
  }
}

function createDefaultProfile() {
  return normalizeProfile({
    nickname: `玩家${randomInt(1000, 10000)}`,
    avatar: `/assets/avatars/avatar-${randomInt(1, AVATAR_COUNT + 1)}.svg`,
  })
}

module.exports = { AVATARS, VIP_AVATARS, normalizeProfile, resolveStoredProfile, createDefaultProfile, getUserState }
