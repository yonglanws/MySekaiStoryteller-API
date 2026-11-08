import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildIrodoriSpeechRequest,
  collectEmotionLabels,
  resolveIrodoriVoice
} from '../../out-host/common/tts/irodori.js'

const defaults = {
  model: 'irodori-tts',
  responseFormat: 'wav',
  numSteps: 40,
  cfgScaleText: 3.0,
  cfgScaleCaption: 3.0,
  cfgScaleSpeaker: 5.0,
  durationScale: 1.0,
  chunkingEnabled: true,
  chunkMinChars: 80,
  seed: -1
}

test('builds an OpenAI-compatible Irodori speech request', () => {
  const payload = buildIrodoriSpeechRequest(
    'こんにちは。',
    {
      refAudioPath: '/models/mizuki/main.wav',
      loraAdapter: '/models/mizuki/lora_adapter',
      caption: '明るく軽い口調で話している。',
      numSteps: 32
    },
    defaults,
    1.1
  )

  assert.equal(payload.model, 'irodori-tts')
  assert.equal(payload.input, 'こんにちは。')
  assert.equal(payload.response_format, 'wav')
  assert.equal(payload.speed, 1.1)
  assert.deepEqual(payload.irodori, {
    ref_wav: '/models/mizuki/main.wav',
    lora_adapter: '/models/mizuki/lora_adapter',
    caption: '明るく軽い口調で話している。',
    num_steps: 32,
    cfg_scale_text: 3,
    cfg_scale_caption: 3,
    cfg_scale_speaker: 5,
    duration_scale: 1,
    chunking_enabled: true,
    chunk_min_chars: 80
  })
})

test('prefers ref_wavs and omits blank or random parameters', () => {
  const payload = buildIrodoriSpeechRequest(
    'テスト',
    {
      refAudioPath: '/ignored.wav',
      refAudioPaths: [' /a.wav ', '', '/b.wav'],
      caption: '   ',
      loraAdapter: '   ',
      speed: 0.9
    },
    { ...defaults, seed: 123 }
  )

  assert.equal(payload.speed, 0.9)
  const irodori = payload.irodori
  assert.deepEqual(irodori.ref_wavs, ['/a.wav', '/b.wav'])
  assert.equal('ref_wav' in irodori, false)
  assert.equal('caption' in irodori, false)
  assert.equal('lora_adapter' in irodori, false)
  assert.equal(irodori.seed, 123)
})

test('emotion entry overrides only non-empty voice fields', () => {
  const base = {
    refAudioPath: '/main.wav',
    loraAdapter: '/lora',
    caption: '普通',
    speed: 1.0
  }
  const emotions = [
    {
      emotion: '开心',
      refAudioPath: '/happy.wav',
      caption: '嬉しそうに話している。',
      speed: 1.15
    },
    { emotion: '平静', refAudioPath: '', caption: '', speed: 0.95 }
  ]

  const happy = resolveIrodoriVoice(base, emotions, '开心')
  assert.equal(happy.refAudioPath, '/happy.wav')
  assert.equal(happy.caption, '嬉しそうに話している。')
  assert.equal(happy.speed, 1.15)
  assert.equal(happy.loraAdapter, '/lora')

  const calm = resolveIrodoriVoice(base, emotions, '平静')
  assert.equal(calm.refAudioPath, '/main.wav')
  assert.equal(calm.caption, '普通')
  assert.equal(calm.speed, 0.95)

  assert.deepEqual(resolveIrodoriVoice(base, emotions, '未知'), base)
  assert.deepEqual(resolveIrodoriVoice(base, emotions, ''), base)
})

test('collects unique emotion labels in configuration order', () => {
  const labels = collectEmotionLabels(
    ['平静', '开心', '平静'],
    [
      { emotions: [{ emotion: '开心' }, { emotion: '生气' }] },
      { emotions: [{ emotion: '伤心' }, { emotion: ' ' }] }
    ]
  )
  assert.deepEqual(labels, ['平静', '开心', '生气', '伤心'])
})
