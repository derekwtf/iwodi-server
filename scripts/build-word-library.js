const fs = require('fs')
const path = require('path')
const { createPairExpander } = require('./word-group-expansions')

const SOURCE_PATH = path.resolve(
  __dirname,
  '../../PRD/words/who_is_the_spy_youth_grouped_200_each.json'
)
const TARGET_PATH = path.resolve(__dirname, '../src/data/words.json')

const CATEGORY_META = {
  food: ['美食', '偏食物、饮品与餐饮场景。'],
  people: ['人物', '偏明星、职业、角色与人物关系。'],
  brands: ['品牌', '偏消费品牌、平台与日常产品。'],
  film_tv_variety: ['影视综艺', '偏影视作品、综艺节目与娱乐内容。'],
  idioms: ['成语表达', '偏成语、俗语与近义表达。'],
  digital_internet: ['数码互联网', '偏 App、设备、互联网与游戏语境。'],
  daily_items: ['日常用品', '偏生活用品、穿搭与家居物件。'],
  city_travel: ['城市出行', '偏城市、交通、出行与线下场景。'],
}

function normalizeWord(value) {
  return String(value || '').trim()
}

function buildPairs(rawPairs) {
  return rawPairs
    .map((pair) => ({
      civilian: normalizeWord(pair.civilian),
      spy: normalizeWord(pair.spy),
    }))
    .filter((pair) => pair.civilian && pair.spy && pair.civilian !== pair.spy)
}

function buildMergedGroups(pairs, categoryKey) {
  const adjacency = new Map()
  const pairKeyMap = new Map()

  pairs.forEach((pair, index) => {
    const forwardKey = `${pair.civilian}__${pair.spy}`
    const reverseKey = `${pair.spy}__${pair.civilian}`
    pairKeyMap.set(forwardKey, index)
    pairKeyMap.set(reverseKey, index)

    if (!adjacency.has(pair.civilian)) {
      adjacency.set(pair.civilian, new Set())
    }
    if (!adjacency.has(pair.spy)) {
      adjacency.set(pair.spy, new Set())
    }

    adjacency.get(pair.civilian).add(pair.spy)
    adjacency.get(pair.spy).add(pair.civilian)
  })

  const candidates = Array.from(adjacency.entries())
    .map(([center, neighbors]) => ({
      center,
      words: [center, ...Array.from(neighbors).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))],
    }))
    .filter((candidate) => candidate.words.length >= 3 && candidate.words.length <= 5)
    .sort((left, right) => {
      if (right.words.length !== left.words.length) {
        return right.words.length - left.words.length
      }

      return left.center.localeCompare(right.center, 'zh-Hans-CN')
    })

  const selectedWords = new Set()
  const coveredPairIndices = new Set()
  const groups = []

  candidates.forEach((candidate) => {
    if (candidate.words.some((word) => selectedWords.has(word))) {
      return
    }

    candidate.words.forEach((word) => {
      selectedWords.add(word)
    })

    candidate.words.slice(1).forEach((neighbor) => {
      const pairIndex = pairKeyMap.get(`${candidate.center}__${neighbor}`)
      if (typeof pairIndex === 'number') {
        coveredPairIndices.add(pairIndex)
      }
    })

    groups.push({
      id: `${categoryKey}-merged-${String(groups.length + 1).padStart(3, '0')}`,
      words: candidate.words,
    })
  })

  return {
    groups,
    coveredPairIndices,
  }
}

function buildCategory(categoryKey, rawPairs, expandPairWords) {
  const pairs = buildPairs(rawPairs)
  const { groups: mergedGroups, coveredPairIndices } = buildMergedGroups(pairs, categoryKey)
  const [label, description] = CATEGORY_META[categoryKey] || [categoryKey, '']

  const pairGroups = pairs
    .map((pair, index) => ({ pair, index }))
    .filter(({ index }) => !coveredPairIndices.has(index))
    .map(({ pair }, index) => ({
      id: `${categoryKey}-pair-${String(index + 1).padStart(3, '0')}`,
      words: [
        pair.civilian,
        pair.spy,
        expandPairWords(categoryKey, [pair.civilian, pair.spy]),
      ].filter(Boolean),
    }))

  return {
    id: categoryKey,
    label,
    description,
    groups: [...mergedGroups, ...pairGroups],
  }
}

function main() {
  const source = require(SOURCE_PATH)
  const expandPairWords = createPairExpander(source)
  const categories = Object.keys(source)
    .filter((key) => key !== 'meta')
    .map((key) => buildCategory(key, source[key], expandPairWords))

  const output = {
    meta: {
      version: 2,
      name: source.meta ? source.meta.name : 'who_is_the_spy_word_library',
      description: '分类词库。每个词组尽量包含 3 个近似但不完全相同的词，发牌时随机抽取其中 2 个并随机分配给平民/卧底。',
      source: path.relative(path.dirname(TARGET_PATH), SOURCE_PATH),
      generatedAt: new Date().toISOString(),
      categoryCount: categories.length,
      groupCount: categories.reduce((total, category) => total + category.groups.length, 0),
      sourcePairCount: categories.reduce(
        (total, category) => total + (source[category.id] ? source[category.id].length : 0),
        0
      ),
    },
    categories,
  }

  fs.writeFileSync(TARGET_PATH, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Generated ${TARGET_PATH}`)
  console.log(JSON.stringify(output.meta, null, 2))
}

main()
