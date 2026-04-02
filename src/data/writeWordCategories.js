const fs = require('fs')
const path = require('path')

function writeWordCategories(dataset, targetDir) {
  const categories = Array.isArray(dataset?.categories)
    ? dataset.categories
    : Array.isArray(dataset)
      ? dataset
      : null

  if (!categories || categories.length === 0) {
    throw new Error('词库分类不能为空')
  }

  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })

  categories.forEach((category) => {
    const filePath = path.join(targetDir, `${category.id}.json`)
    fs.writeFileSync(filePath, `${JSON.stringify(category, null, 2)}\n`)
  })
}

module.exports = writeWordCategories
