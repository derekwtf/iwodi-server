const { randomInt } = require('crypto')

const AVATARS = new Set(Array.from({ length: 32 }, (_, index) =>
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

function createDefaultProfile() {
  return normalizeProfile({
    nickname: `玩家${randomInt(1000, 10000)}`,
    avatar: `/assets/avatars/avatar-${randomInt(1, 33)}.svg`,
  })
}

module.exports = { normalizeProfile, createDefaultProfile }
