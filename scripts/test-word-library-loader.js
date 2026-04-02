const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const loadWordCategories = require('../src/data/loadWordCategories')

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-library-loader-'))

  try {
    run(tempDir)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function testLoadsCategoryFiles() {
  withTempDir((tempDir) => {
    writeJson(path.join(tempDir, 'food.json'), {
      id: 'food',
      label: '美食',
      description: '测试分类',
      groups: [
        { id: 'food-001', words: ['牛奶', '豆浆'] },
        { id: 'food-002', words: ['米饭', '面条', '馒头'] },
      ],
    })

    writeJson(path.join(tempDir, 'people.json'), {
      id: 'people',
      label: '人物',
      groups: [
        { id: 'people-001', words: ['老师', '校长'] },
      ],
    })

    const dataset = loadWordCategories(tempDir)

    assert.strictEqual(dataset.categories.length, 2)
    assert.strictEqual(dataset.meta.totalCategories, 2)
    assert.strictEqual(dataset.meta.totalGroups, 3)
    assert.strictEqual(dataset.meta.source, 'category-files')
    assert.strictEqual(dataset.categories[0].id, 'food')
    assert.strictEqual(dataset.categories[1].id, 'people')
  })
}

function testRejectsEmptyDirectory() {
  withTempDir((tempDir) => {
    assert.throws(() => loadWordCategories(tempDir), /词库分类不能为空/)
  })
}

function testRejectsFilenameMismatch() {
  withTempDir((tempDir) => {
    writeJson(path.join(tempDir, 'food.json'), {
      id: 'drink',
      label: '饮品',
      groups: [{ id: 'drink-001', words: ['咖啡', '奶茶'] }],
    })

    assert.throws(() => loadWordCategories(tempDir), /文件名与分类 id 不一致/)
  })
}

function testRejectsDuplicateCategoryId() {
  withTempDir((tempDir) => {
    const firstDir = path.join(tempDir, '01')
    const secondDir = path.join(tempDir, '02')
    fs.mkdirSync(firstDir)
    fs.mkdirSync(secondDir)

    writeJson(path.join(firstDir, 'food.json'), {
      id: 'food',
      label: '美食',
      groups: [{ id: 'food-001', words: ['牛奶', '豆浆'] }],
    })

    writeJson(path.join(secondDir, 'food.json'), {
      id: 'food',
      label: '早餐',
      groups: [{ id: 'food-002', words: ['包子', '馒头'] }],
    })

    assert.throws(
      () => loadWordCategories([firstDir, secondDir]),
      /词库分类重复: food/
    )
  })
}

function main() {
  testLoadsCategoryFiles()
  testRejectsEmptyDirectory()
  testRejectsFilenameMismatch()
  testRejectsDuplicateCategoryId()
  console.log('Word library loader tests passed.')
}

main()
