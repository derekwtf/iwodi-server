const { randomInt } = require('crypto')

const AVATAR_COUNT = 20
const AVATARS = new Set(Array.from({ length: AVATAR_COUNT }, (_, index) =>
  `/assets/avatars/avatar-${index + 1}.svg`))

function normalizeProfile({ nickname, avatar } = {}) {
  const normalized = typeof nickname === 'string' ? nickname.trim().slice(0, 20) : ''
  if (!normalized) {
    throw Object.assign(new Error('请输入昵称'), { code: 'INVALID_NICKNAME' })
  }
  if (!AVATARS.has(avatar)) {
    throw Object.assign(new Error('请选择普通头像'), { code: 'INVALID_AVATAR' })
  }
  return { nickname: normalized, avatar }
}

function resolveStoredProfile(profile) {
  if (!profile || AVATARS.has(profile.avatar)) return profile
  return { ...profile, avatar: '/assets/avatars/avatar-1.svg' }
}

function createDefaultProfile() {
  return normalizeProfile({
    nickname: `玩家${randomInt(1000, 10000)}`,
    avatar: `/assets/avatars/avatar-${randomInt(1, AVATAR_COUNT + 1)}.svg`,
  })
}

module.exports = { normalizeProfile, resolveStoredProfile, createDefaultProfile }
