const defaultPairs = require('./words.json')

class WordLibrary {
  constructor(wordPairs = defaultPairs) {
    if (!Array.isArray(wordPairs) || wordPairs.length === 0) {
      throw new Error('词库不能为空')
    }

    this.wordPairs = wordPairs.map((pair, index) => {
      if (!pair || !pair.civilian || !pair.spy) {
        throw new Error(`词库格式错误，索引 ${index}`)
      }

      return {
        civilian: String(pair.civilian).trim(),
        spy: String(pair.spy).trim(),
      }
    })
  }

  get size() {
    return this.wordPairs.length
  }

  getRandomPair(excludeIndices = []) {
    const excluded = new Set(excludeIndices)
    const available = this.wordPairs
      .map((pair, index) => ({ ...pair, index }))
      .filter((pair) => !excluded.has(pair.index))

    const source = available.length > 0 ? available : this.wordPairs.map((pair, index) => ({
      ...pair,
      index,
    }))
    const target = source[Math.floor(Math.random() * source.length)]

    return {
      index: target.index,
      civilian: target.civilian,
      spy: target.spy,
    }
  }
}

module.exports = WordLibrary
