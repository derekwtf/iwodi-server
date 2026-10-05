const loadWordCategories = require('./loadWordCategories')

function normalizeWord(value) {
  return String(value || '').trim()
}

function toUniqueWords(words) {
  const seen = new Set()

  return words.filter((word) => {
    if (!word || seen.has(word)) {
      return false
    }

    seen.add(word)
    return true
  })
}

function pickRandomItem(list) {
  return list[Math.floor(Math.random() * list.length)]
}

class WordLibrary {
  constructor(wordGroups = null) {
    const source = wordGroups || loadWordCategories()
    const normalized = this.normalizeSource(source)

    if (normalized.groups.length === 0) {
      throw new Error('词库不能为空')
    }

    this.meta = normalized.meta
    this.categories = normalized.categories
    this.wordGroups = normalized.groups
  }

  get size() {
    return this.wordGroups.length
  }

  getCategories() {
    return this.categories.map((category) => ({ ...category }))
  }

  getRandomPair(options = {}) {
    const normalizedOptions = Array.isArray(options)
      ? { excludeIndices: options }
      : options
    const excluded = new Set(normalizedOptions.excludeIndices || [])
    const excludedKeys = new Set(normalizedOptions.excludeKeys || [])
    const requestedCategories = Array.isArray(normalizedOptions.categories)
      ? new Set(normalizedOptions.categories.map(normalizeWord).filter(Boolean))
      : null
    const available = this.wordGroups.filter((group) => {
      if (excluded.has(group.index) || excludedKeys.has(`language:${group.categoryId}:${group.groupId}`)) {
        return false
      }

      if (requestedCategories && !requestedCategories.has(group.categoryId)) {
        return false
      }

      return true
    })
    const source = available.length > 0
      ? available
      : this.wordGroups.filter((group) => {
          if (!requestedCategories) {
            return true
          }

          return requestedCategories.has(group.categoryId)
        })

    if (source.length === 0) {
      throw new Error('指定分类下没有可用词组')
    }

    const target = pickRandomItem(source)
    const selectedWords = this.pickDistinctWords(target.words, 2)
    const [firstWord, secondWord] = selectedWords
    const civilianFirst = Math.random() < 0.5

    return {
      index: target.index,
      historyReset: available.length === 0,
      groupId: target.groupId,
      categoryId: target.categoryId,
      categoryLabel: target.categoryLabel,
      candidateWords: [...target.words],
      civilian: civilianFirst ? firstWord : secondWord,
      spy: civilianFirst ? secondWord : firstWord,
    }
  }

  pickDistinctWords(words, count) {
    const shuffled = [...words]

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1))
      const current = shuffled[index]
      shuffled[index] = shuffled[swapIndex]
      shuffled[swapIndex] = current
    }

    return shuffled.slice(0, count)
  }

  normalizeSource(source) {
    if (Array.isArray(source)) {
      return this.normalizeCategoryCollection([
        {
          id: 'default',
          label: '默认词库',
          groups: source,
        },
      ], {})
    }

    if (!source || typeof source !== 'object') {
      throw new Error('词库格式错误')
    }

    if (Array.isArray(source.categories)) {
      return this.normalizeCategoryCollection(source.categories, source.meta || {})
    }

    const categoryIds = Object.keys(source).filter((key) => key !== 'meta')
    if (categoryIds.length === 0) {
      throw new Error('词库分类不能为空')
    }

    return this.normalizeCategoryCollection(
      categoryIds.map((categoryId) => ({
        id: categoryId,
        label: categoryId,
        groups: source[categoryId],
      })),
      source.meta || {}
    )
  }

  normalizeCategoryCollection(categories, meta) {
    const normalizedCategories = []
    const normalizedGroups = []

    categories.forEach((category, categoryIndex) => {
      const categoryId = normalizeWord(category.id) || `category-${categoryIndex + 1}`
      const categoryLabel = normalizeWord(category.label) || categoryId
      const rawGroups = Array.isArray(category.groups) ? category.groups : []

      if (rawGroups.length === 0) {
        return
      }

      const groups = rawGroups.map((group, groupIndex) =>
        this.normalizeGroup(group, {
          groupIndex,
          categoryId,
          categoryLabel,
          categoryDescription: normalizeWord(category.description),
        })
      )

      normalizedCategories.push({
        id: categoryId,
        label: categoryLabel,
        description: normalizeWord(category.description),
        size: groups.length,
      })

      groups.forEach((group) => {
        normalizedGroups.push({
          index: normalizedGroups.length,
          ...group,
        })
      })
    })

    return {
      meta: {
        ...meta,
        totalCategories: normalizedCategories.length,
        totalGroups: normalizedGroups.length,
      },
      categories: normalizedCategories,
      groups: normalizedGroups,
    }
  }

  normalizeGroup(group, {
    groupIndex,
    categoryId,
    categoryLabel,
    categoryDescription,
  }) {
    let words = []
    let groupId = ''

    if (Array.isArray(group?.words)) {
      words = group.words.map(normalizeWord)
      groupId = normalizeWord(group.id)
    } else if (group && typeof group === 'object' && group.civilian && group.spy) {
      words = [normalizeWord(group.civilian), normalizeWord(group.spy)]
    }

    const uniqueWords = toUniqueWords(words)

    if (uniqueWords.length < 2) {
      throw new Error(`词库格式错误，分类 ${categoryId} 索引 ${groupIndex}`)
    }

    return {
      groupId: groupId || `${categoryId}-${groupIndex + 1}`,
      categoryId,
      categoryLabel,
      categoryDescription,
      words: uniqueWords,
    }
  }
}

module.exports = WordLibrary
