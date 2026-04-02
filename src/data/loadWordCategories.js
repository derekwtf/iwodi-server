const fs = require('fs')
const path = require('path')

const DEFAULT_WORDS_DIR = path.resolve(__dirname, 'words')

function normalizeWord(value) {
  return String(value || '').trim()
}

function toDirectoryList(input) {
  if (Array.isArray(input)) {
    return input
  }

  return [input || DEFAULT_WORDS_DIR]
}

function readCategoryFiles(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    throw new Error(`词库目录不存在: ${directoryPath}`)
  }

  return fs.readdirSync(directoryPath)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((fileName) => ({
      fileName,
      filePath: path.join(directoryPath, fileName),
    }))
}

function parseCategoryFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`词库分类文件解析失败: ${filePath}`)
  }
}

function validateCategory(category, fileName) {
  if (!category || typeof category !== 'object' || Array.isArray(category)) {
    throw new Error(`词库分类格式错误: ${fileName}`)
  }

  const categoryId = normalizeWord(category.id)
  const categoryLabel = normalizeWord(category.label)

  if (!categoryId || !categoryLabel || !Array.isArray(category.groups)) {
    throw new Error(`词库分类格式错误: ${fileName}`)
  }

  if (path.basename(fileName, '.json') !== categoryId) {
    throw new Error(`文件名与分类 id 不一致: ${fileName}`)
  }

  if (category.groups.length === 0) {
    throw new Error(`词库分类不能为空: ${categoryId}`)
  }
}

function loadWordCategories(input) {
  const directories = toDirectoryList(input)
  const categories = []
  const categoryIds = new Set()

  directories.forEach((directoryPath) => {
    const categoryFiles = readCategoryFiles(directoryPath)

    categoryFiles.forEach(({ fileName, filePath }) => {
      const category = parseCategoryFile(filePath)
      validateCategory(category, fileName)

      if (categoryIds.has(category.id)) {
        throw new Error(`词库分类重复: ${category.id}`)
      }

      categoryIds.add(category.id)
      categories.push(category)
    })
  })

  if (categories.length === 0) {
    throw new Error('词库分类不能为空')
  }

  return {
    meta: {
      version: 3,
      source: 'category-files',
      totalCategories: categories.length,
      totalGroups: categories.reduce(
        (total, category) => total + category.groups.length,
        0
      ),
    },
    categories,
  }
}

module.exports = loadWordCategories
module.exports.DEFAULT_WORDS_DIR = DEFAULT_WORDS_DIR
