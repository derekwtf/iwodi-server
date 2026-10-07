const assert = require('assert')
const WordLibrary = require('../src/data/WordLibrary')
const loadWordCategories = require('../src/data/loadWordCategories')

const dataset = loadWordCategories()

function testLegacyCompatibility() {
  const library = new WordLibrary([
    { civilian: '苹果', spy: '香蕉' },
    { civilian: '猫', spy: '狗' },
  ])

  assert.strictEqual(library.size, 2)
  const pair = library.getRandomPair()
  assert.notStrictEqual(pair.civilian, pair.spy)
  assert.ok(['苹果', '香蕉', '猫', '狗'].includes(pair.civilian))
  assert.ok(['苹果', '香蕉', '猫', '狗'].includes(pair.spy))
}

function testCategorizedDataset() {
  const library = new WordLibrary(dataset)
  const categories = library.getCategories()

  assert.ok(categories.length >= 15)
  assert.ok(categories.some((category) => category.id === 'food'))
  assert.ok(categories.some((category) => category.id === 'people'))
  assert.ok(library.size >= 700)
}

function testDefaultDirectoryLoading() {
  const library = new WordLibrary()

  assert.ok(library.size >= 700)
  assert.ok(library.getCategories().length >= 15)
}

function testMultiWordSelection() {
  const library = new WordLibrary({
    meta: {},
    categories: [
      {
        id: 'daily_items',
        label: '日常用品',
        groups: [
          {
            id: 'daily-items-001',
            words: ['纸巾', '湿巾', '手帕'],
          },
        ],
      },
    ],
  })

  const observedWords = new Set()
  for (let index = 0; index < 40; index += 1) {
    const pair = library.getRandomPair()
    observedWords.add(pair.civilian)
    observedWords.add(pair.spy)
    assert.strictEqual(pair.candidateWords.length, 3)
    assert.ok(pair.candidateWords.includes(pair.civilian))
    assert.ok(pair.candidateWords.includes(pair.spy))
  }

  assert.strictEqual(observedWords.size, 3)
}

function testCategoryFiltering() {
  const library = new WordLibrary({
    meta: {},
    categories: [
      {
        id: 'food',
        label: '食物',
        groups: [{ words: ['牛奶', '豆浆'] }],
      },
      {
        id: 'city_travel',
        label: '城市出行',
        groups: [{ words: ['杭州', '苏州'] }],
      },
    ],
  })

  const pair = library.getRandomPair({
    categories: ['city_travel'],
  })

  assert.strictEqual(pair.categoryId, 'city_travel')
  assert.ok(['杭州', '苏州'].includes(pair.civilian))
  assert.ok(['杭州', '苏州'].includes(pair.spy))
}

function testDatasetCandidatePairsAreUnique() {
  const categoryIds = new Set()
  const groupIds = new Set()
  const candidatePairs = new Map()

  assert.strictEqual(dataset.meta.totalCategories, dataset.categories.length)
  assert.strictEqual(dataset.meta.totalGroups, dataset.categories.reduce((total, category) => total + category.groups.length, 0))

  dataset.categories.forEach((category) => {
    assert.ok(!categoryIds.has(category.id), `重复分类 ID: ${category.id}`)
    categoryIds.add(category.id)
    assert.strictEqual(category.groupCount, category.groups.length, `分类词组数量不一致: ${category.id}`)
    category.groups.forEach((group) => {
      assert.ok(group.id.startsWith(`${category.id}-`), `词组 ID 与分类不一致: ${group.id}`)
      assert.ok(!groupIds.has(group.id), `重复词组 ID: ${group.id}`)
      groupIds.add(group.id)
      assert.ok(Array.isArray(group.words), `候选词格式异常: ${group.id}`)
      assert.ok(group.words.length >= 2 && group.words.length <= 3, `候选词数量异常: ${group.id}`)
      assert.strictEqual(new Set(group.words).size, group.words.length, `组内词语重复: ${group.id}`)
      group.words.forEach((word) => {
        assert.ok(typeof word === 'string' && word && word === word.trim(), `词语为空或含首尾空格: ${group.id}`)
      })

      for (let first = 0; first < group.words.length; first += 1) {
        const firstWord = group.words[first]
        for (let second = first + 1; second < group.words.length; second += 1) {
          const pair = [firstWord, group.words[second]].sort().join(' / ')
          assert.ok(!candidatePairs.has(pair), `重复可抽取词对: ${candidatePairs.get(pair)} 和 ${group.id} (${pair})`)
          candidatePairs.set(pair, group.id)
        }
      }
    })
  })
}

function testEveryCategoryCanBeSelected() {
  const library = new WordLibrary(dataset)
  const previousRandom = Math.random

  try {
    dataset.categories.forEach((category) => {
      for (const randomValue of [0, 0.99]) {
        Math.random = () => randomValue
        const pair = library.getRandomPair({ categories: [category.id] })
        assert.strictEqual(pair.categoryId, category.id)
        assert.strictEqual(pair.categoryLabel, category.label)
        assert.ok(category.groups.some((group) => group.id === pair.groupId))
      }
    })
  } finally {
    Math.random = previousRandom
  }
}

function testDatasetPairsCanBeDealtInBothDirections() {
  const previousRandom = Math.random

  try {
    dataset.categories.forEach((category) => {
      category.groups.forEach((group) => {
        const library = new WordLibrary({ categories: [{ ...category, groups: [group] }] })

        for (let firstIndex = 0; firstIndex < group.words.length; firstIndex += 1) {
          for (let secondIndex = firstIndex + 1; secondIndex < group.words.length; secondIndex += 1) {
            const firstWord = group.words[firstIndex]
            const secondWord = group.words[secondIndex]
            const targetWords = [firstWord, secondWord, ...group.words.filter((word) => word !== firstWord && word !== secondWord)]
            const shuffledWords = [...group.words]
            const shuffleValues = [0]

            for (let cursor = shuffledWords.length - 1; cursor > 0; cursor -= 1) {
              const swapIndex = shuffledWords.indexOf(targetWords[cursor])
              shuffleValues.push((swapIndex + 0.5) / (cursor + 1))
              const currentWord = shuffledWords[cursor]
              shuffledWords[cursor] = shuffledWords[swapIndex]
              shuffledWords[swapIndex] = currentWord
            }

            for (const civilianFirst of [true, false]) {
              const randomValues = [...shuffleValues, civilianFirst ? 0 : 0.99]
              let randomIndex = 0
              Math.random = () => randomValues[randomIndex++]
              const pair = library.getRandomPair()
              const context = `${group.id}: ${firstWord} / ${secondWord}`

              assert.strictEqual(pair.groupId, group.id, context)
              assert.strictEqual(pair.categoryId, category.id, context)
              assert.deepStrictEqual(pair.candidateWords, group.words, context)
              assert.strictEqual(pair.civilian, civilianFirst ? firstWord : secondWord, context)
              assert.strictEqual(pair.spy, civilianFirst ? secondWord : firstWord, context)
              assert.strictEqual(randomIndex, randomValues.length, context)
            }
          }
        }
      })
    })
  } finally {
    Math.random = previousRandom
  }
}

function main() {
  testLegacyCompatibility()
  testCategorizedDataset()
  testDefaultDirectoryLoading()
  testMultiWordSelection()
  testCategoryFiltering()
  testDatasetCandidatePairsAreUnique()
  testEveryCategoryCanBeSelected()
  testDatasetPairsCanBeDealtInBothDirections()
  console.log('Word library tests passed.')
}

main()
