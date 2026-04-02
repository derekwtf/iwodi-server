const assert = require('assert')
const WordLibrary = require('../src/data/WordLibrary')
const dataset = require('../src/data/words.json')

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

function main() {
  testLegacyCompatibility()
  testCategorizedDataset()
  testMultiWordSelection()
  testCategoryFiltering()
  console.log('Word library tests passed.')
}

main()
