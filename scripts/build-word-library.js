const fs = require('fs')
const path = require('path')
const loadWordCategories = require('../src/data/loadWordCategories')
const writeWordCategories = require('../src/data/writeWordCategories')

const LEGACY_SOURCE_PATH = path.resolve(__dirname, '../src/data/words.json')
const TARGET_DIR = path.resolve(__dirname, '../src/data/words')

function loadSourceDataset() {
  if (fs.existsSync(LEGACY_SOURCE_PATH)) {
    return JSON.parse(fs.readFileSync(LEGACY_SOURCE_PATH, 'utf8'))
  }

  return loadWordCategories(TARGET_DIR)
}

function buildMeta(dataset) {
  return {
    ...(dataset.meta || {}),
    source: 'category-files',
    totalCategories: dataset.categories.length,
    totalGroups: dataset.categories.reduce(
      (total, category) => total + category.groups.length,
      0
    ),
    generatedAt: new Date().toISOString(),
  }
}

function main() {
  const dataset = loadSourceDataset()
  const output = {
    meta: buildMeta(dataset),
    categories: dataset.categories,
  }

  writeWordCategories(output, TARGET_DIR)
  console.log(`Generated ${TARGET_DIR}`)
  console.log(JSON.stringify(output.meta, null, 2))
}

main()
