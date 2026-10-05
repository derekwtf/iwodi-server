const path = require('path')
const loadWordCategories = require('./loadWordCategories')

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('肢体提示字段不能为空')
  return value.trim()
}

class BodyPromptLibrary {
  constructor(source = loadWordCategories(path.join(__dirname, 'body-prompts'))) {
    if (!source || !Array.isArray(source.categories) || !source.categories.length) {
      throw new Error('肢体提示库不能为空')
    }
    const categoryIds = new Set()
    const groupIds = new Set()
    const pairs = new Set()
    this.wordGroups = []
    this.categories = source.categories.map((category) => {
      const categoryId = requireText(category.id)
      const categoryLabel = requireText(category.label)
      if (category.playMode !== 'body' || categoryIds.has(categoryId) ||
        !Array.isArray(category.groups) || !category.groups.length) {
        throw new Error('肢体提示分类或模式错误')
      }
      categoryIds.add(categoryId)
      category.groups.forEach((group) => {
        const groupId = requireText(group.id)
        const sharedAction = requireText(group.sharedAction)
        if (groupIds.has(groupId) || !Array.isArray(group.variants) || group.variants.length !== 2) {
          throw new Error('肢体提示对 ID 重复或变体数量错误')
        }
        groupIds.add(groupId)
        const variantIds = new Set()
        const variants = group.variants.map((variant) => {
          const id = requireText(variant.id)
          const text = requireText(variant.text)
          if (variantIds.has(id) || !Array.isArray(variant.performanceSteps) ||
            variant.performanceSteps.length !== 2) throw new Error('肢体提示变体或步骤错误')
          variantIds.add(id)
          const performanceSteps = variant.performanceSteps.map(requireText)
          if (performanceSteps[0] !== sharedAction) throw new Error('肢体提示共同动作不一致')
          return { id, text, performanceSteps }
        })
        const pairKey = JSON.stringify(variants.map((variant) => variant.text).sort())
        if (variants[0].text === variants[1].text || pairs.has(pairKey)) {
          throw new Error('肢体提示配对重复')
        }
        pairs.add(pairKey)
        this.wordGroups.push({ groupId, categoryId, categoryLabel, sharedAction, variants })
      })
      return { id: categoryId, label: categoryLabel, size: category.groups.length }
    })
  }

  get size() { return this.wordGroups.length }

  getCategories() { return this.categories.map((category) => ({ ...category })) }

  getRandomPair({ excludeKeys = [], categories } = {}) {
    const eligible = this.wordGroups.filter((group) => !categories || categories.includes(group.categoryId))
    const excluded = new Set(excludeKeys)
    const available = eligible.filter((group) => !excluded.has(`body:${group.categoryId}:${group.groupId}`))
    const source = available.length ? available : eligible
    if (!source.length) throw new Error('没有可用的肢体情境，请稍后重试')
    const group = source[Math.floor(Math.random() * source.length)]
    const [civilian, spy] = Math.random() < 0.5 ? group.variants : [...group.variants].reverse()
    return {
      groupId: group.groupId,
      categoryId: group.categoryId,
      categoryLabel: group.categoryLabel,
      civilian: civilian.text,
      spy: spy.text,
      civilianSteps: [...civilian.performanceSteps],
      spySteps: [...spy.performanceSteps],
      historyReset: available.length === 0,
    }
  }
}

module.exports = BodyPromptLibrary
