/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 问题 3：IrodoriTTS 只能读日文。
 * 宿主必须把空/中文 ttsText 补成日文；renderer 对 Irodori 再做最后一道校验，
 * 非日文直接拒绝合成，绝不退回中文 content。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  isJapaneseText,
  hasTranslationContent,
  collectTtsTargets,
  ensureJapaneseTtsText,
  TtsTextTranslationError
} = require('../../out-host/host/ai/ttsText.js')
const {
  selectSpeechText,
  isJapaneseSpeechText,
  needsJapaneseTtsPreflight
} = require('../../out-host/common/tts/speechText.js')

const talk = (content, ttsText = '') => ({
  type: 'Talk',
  wait: false,
  delay: 0,
  data: { speaker: 'A', content, modelId: 1, ttsText }
})

test('Japanese detection uses kana and treats Chinese/empty as needing translation', () => {
  assert.equal(isJapaneseText('こんにちは、今日も練習しよう'), true)
  assert.equal(isJapaneseText('ハロー！'), true)
  assert.equal(isJapaneseText('你好，今天也一起练习吧'), false)
  assert.equal(isJapaneseText('已经很晚了'), false)
  assert.equal(isJapaneseText('已经这么晚了'), false)
  assert.equal(isJapaneseText(''), false)
  assert.equal(isJapaneseText('……'), false)
  // 官方日文台词允许纯汉字 + 标点（没有假名），不能被当成漏翻
  assert.equal(isJapaneseText('瑞希、私…………'), true)
  assert.equal(isJapaneseText('瑞希——'), true)
  assert.equal(isJapaneseText('——瑞希！！'), true)
  assert.equal(isJapaneseText('了解'), true)
  assert.equal(isJapaneseText('無言'), true)
  assert.equal(isJapaneseText('感謝'), true)
  assert.equal(isJapaneseText('給与'), true)
  assert.equal(isJapaneseText('瑞希，我…………'), false)
  assert.equal(isJapaneseSpeechText('ありがとう'), true)
  assert.equal(isJapaneseSpeechText('谢谢'), false)
  assert.equal(isJapaneseSpeechText('瑞希……！'), true)
})

test('Japanese preflight only runs for enabled Irodori TTS', () => {
  assert.equal(needsJapaneseTtsPreflight({ enabled: true, provider: 'irodori' }), true)
  assert.equal(needsJapaneseTtsPreflight({ enabled: false, provider: 'irodori' }), false)
  assert.equal(needsJapaneseTtsPreflight({ enabled: true, provider: 'gpt-sovits' }), false)
})

test('collectTtsTargets finds empty and Chinese ttsText but keeps Japanese', () => {
  const story = {
    models: [],
    images: [],
    snippets: [
      talk('今天也一起练吧。', ''),
      talk('嗯。', 'うん。'),
      talk('已经这么晚了。', '已经很晚了')
    ]
  }
  assert.deepEqual(
    collectTtsTargets(story).map((target) => target.snippetIndex),
    [0, 2]
  )
})

test('official corpus with kanji-only ttsText passes the preflight unchanged', async () => {
  const localFile = new URL('../../resources/stories/event_145_08.sekai-story.json', import.meta.url)
  const fallbackRoot = process.env.MSS_RESOURCE_DIR?.trim()
  const filePath = existsSync(localFile)
    ? localFile
    : fallbackRoot
      ? `${fallbackRoot.replace(/[\\/]+$/, '')}/stories/event_145_08.sekai-story.json`
      : localFile
  const story = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.deepEqual(
    collectTtsTargets(story).map((target) => target.snippetIndex),
    [],
    'official kanji-only ttsText must not be queued for translation'
  )
  let translateCalls = 0
  const result = await ensureJapaneseTtsText(
    story,
    async () => {
      translateCalls += 1
      return []
    },
    { info() {}, warn() {} },
    { strict: true }
  )
  assert.equal(translateCalls, 0)
  assert.equal(result.translated, 0)
  assert.deepEqual(result.missing, [])
})

test('collectTtsTargets ignores punctuation-only Talk that needs no translation', () => {
  const story = {
    models: [],
    images: [],
    snippets: [talk('……', ''), talk('——♪', ''), talk('！？', ''), talk('OK！', '')]
  }
  assert.equal(hasTranslationContent('……'), false)
  assert.equal(hasTranslationContent('——♪'), false)
  assert.equal(hasTranslationContent('OK！'), true)
  // 纯标点不进入翻译队列；含拉丁字母/数字的行仍然需要处理
  assert.deepEqual(
    collectTtsTargets(story).map((target) => target.snippetIndex),
    [3]
  )
})

test('ensureJapaneseTtsText translates only missing/non-Japanese lines', async () => {
  const story = {
    models: [],
    images: [],
    snippets: [
      talk('今天也一起练吧。', ''),
      talk('嗯。', 'うん。'),
      talk('已经这么晚了。', '已经很晚了')
    ]
  }
  const calls = []
  const result = await ensureJapaneseTtsText(
    story,
    async (texts) => {
      calls.push(texts)
      return texts.map((_, index) =>
        index === 0 ? '今日も一緒に練習しよう。' : 'もうこんな時間。'
      )
    },
    { info() {}, warn() {} }
  )
  assert.deepEqual(calls, [['今天也一起练吧。', '已经这么晚了。']])
  assert.equal(result.translated, 2)
  assert.deepEqual(result.missing, [])
  assert.equal(story.snippets[0].data.ttsText, '今日も一緒に練習しよう。')
  assert.equal(story.snippets[1].data.ttsText, 'うん。')
  assert.equal(story.snippets[2].data.ttsText, 'もうこんな時間。')
})

test('ensureJapaneseTtsText strict preflight passes when only punctuation is left', async () => {
  const story = { models: [], images: [], snippets: [talk('……', ''), talk('嗯。', 'うん。')] }
  const result = await ensureJapaneseTtsText(
    story,
    async () => {
      throw new Error('不应为纯标点调用翻译')
    },
    { info() {}, warn() {} },
    { strict: true }
  )
  assert.equal(result.translated, 0)
  assert.deepEqual(result.missing, [])
})

test('ensureJapaneseTtsText retries remaining lines with a smaller batch', async () => {
  const story = {
    models: [],
    images: [],
    snippets: [talk('今天也一起练吧。', ''), talk('已经这么晚了。', '')]
  }
  let calls = 0
  const result = await ensureJapaneseTtsText(
    story,
    async (texts) => {
      calls += 1
      // 第一轮返回长度不对，模拟模型漏掉一条；第二轮按小批量补齐
      if (calls === 1) return ['今日も一緒に練習しよう。']
      return texts.map((_, index) =>
        index === 0 ? '今日も一緒に練習しよう。' : 'もうこんな時間。'
      )
    },
    { info() {}, warn() {} },
    { strict: true }
  )
  assert.equal(calls, 2)
  assert.equal(result.missing.length, 0)
  assert.equal(story.snippets[0].data.ttsText, '今日も一緒に練習しよう。')
  assert.equal(story.snippets[1].data.ttsText, 'もうこんな時間。')
})

test('ensureJapaneseTtsText runs translation batches concurrently', async () => {
  const story = {
    models: [],
    images: [],
    snippets: Array.from({ length: 6 }, (_, index) => talk(`第${index}句中文台词。`, ''))
  }
  let active = 0
  let maxActive = 0
  const translate = async (texts) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return texts.map((text) => `${text}です`)
  }
  const result = await ensureJapaneseTtsText(
    story,
    translate,
    { info() {}, warn() {} },
    {
      chunkSize: 2,
      concurrency: 3
    }
  )
  assert.equal(result.translated, 6)
  assert.deepEqual(result.missing, [])
  // 6 条 / 每批 2 条 = 3 批，应当同时发出
  assert.equal(maxActive, 3)
  assert.ok(story.snippets.every((snippet) => snippet.data.ttsText.endsWith('です')))
})

test('ensureJapaneseTtsText can still translate serially when concurrency is 1', async () => {
  const story = {
    models: [],
    images: [],
    snippets: Array.from({ length: 4 }, (_, index) => talk(`第${index}句中文台词。`, ''))
  }
  let active = 0
  let maxActive = 0
  await ensureJapaneseTtsText(
    story,
    async (texts) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return texts.map((text) => `${text}です`)
    },
    { info() {}, warn() {} },
    { chunkSize: 2, concurrency: 1 }
  )
  assert.equal(maxActive, 1)
})

test('ensureJapaneseTtsText keeps missing lines and can fail strictly', async () => {
  const story = { models: [], images: [], snippets: [talk('今天也一起练吧。', '')] }
  const warnings = []
  const result = await ensureJapaneseTtsText(story, async () => ['今天也一起练吧。'], {
    info() {},
    warn: (message) => warnings.push(message)
  })
  assert.equal(result.translated, 0)
  assert.deepEqual(result.missing, [0])
  assert.ok(warnings.some((message) => message.includes('不是日文')))
  await assert.rejects(
    ensureJapaneseTtsText(
      story,
      async () => ['今天也一起练吧。'],
      { info() {}, warn() {} },
      { strict: true }
    ),
    TtsTextTranslationError
  )
})

test('Irodori selection never falls back to Chinese content', () => {
  assert.equal(selectSpeechText('irodori', 'こんにちは', '你好'), 'こんにちは')
  assert.equal(selectSpeechText('irodori', '', '你好'), null)
  assert.equal(selectSpeechText('irodori', '你好', '你好'), null)
  assert.equal(selectSpeechText('gpt-sovits', '', '你好'), '你好')
  assert.equal(selectSpeechText('gpt-sovits', 'こんにちは', '你好'), 'こんにちは')
})
