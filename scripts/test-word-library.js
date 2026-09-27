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

  assert.ok(categories.length >= 8)
  assert.ok(categories.some((category) => category.id === 'food'))
  assert.ok(categories.some((category) => category.id === 'people'))
  assert.ok(library.size >= 400)
}

function testDefaultDirectoryLoading() {
  const library = new WordLibrary()

  assert.ok(library.size >= 400)
  assert.ok(library.getCategories().length >= 8)
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
  const groupIds = new Set()
  const candidatePairs = new Map()

  dataset.categories.forEach((category) => {
    assert.strictEqual(category.groupCount, category.groups.length, `分类词组数量不一致: ${category.id}`)
    category.groups.forEach((group) => {
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

function main() {
  testLegacyCompatibility()
  testCategorizedDataset()
  testDefaultDirectoryLoading()
  testMultiWordSelection()
  testCategoryFiltering()
  testDatasetCandidatePairsAreUnique()
  console.log('Word library tests passed.')
}

main()
