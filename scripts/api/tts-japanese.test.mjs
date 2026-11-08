/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 问题 3：IrodoriTTS 只能读日文。
 * 宿主必须把空/中文 ttsText 补成日文；renderer 对 Irodori 再做最后一道校验，
 * 非日文直接拒绝合成，绝不退回中文 content。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  isJapaneseText,
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
  assert.equal(isJapaneseText(''), false)
  assert.equal(isJapaneseText('……'), false)
  assert.equal(isJapaneseSpeechText('ありがとう'), true)
  assert.equal(isJapaneseSpeechText('谢谢'), false)
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
