import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildIrodoriSpeechRequest,
  collectEmotionLabels,
  enforceIrodoriEmojiBudget,
  normalizeIrodoriSpeechText,
  resolveIrodoriVoice,
  sanitizeIrodoriCaption
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

test('sanitizeIrodoriCaption strips identity/timbre-conflict words while preserving prosody', () => {
  const cleaned = sanitizeIrodoriCaption(
    '若い女性の低い声で、少し照れながら早口で慌てたように話している。'
  )
  assert.ok(!cleaned.includes('若い女性'))
  assert.ok(!cleaned.includes('低い声'))
  assert.ok(cleaned.includes('少し照れながら早口で慌てたように話している。'))

  const animeCleaned = sanitizeIrodoriCaption(
    '少女のようなアニメ声・幼い声、震える口調で泣き出しそうに訴える。'
  )
  assert.ok(!/少女|アニメ声|幼い声/.test(animeCleaned))
  assert.ok(animeCleaned.includes('震える口調で泣き出しそうに訴える。'))

  const longCaption = '柔らかく温かい口調で、'.repeat(20)
  const capped = sanitizeIrodoriCaption(longCaption)
  assert.ok(capped.length <= 120)
})

test('normalizeIrodoriSpeechText guards bare punctuation/sokuon and enforces emoji budget', () => {
  // Bare sokuon (the #10 hallucination trigger) must never be sent raw
  const gasp = normalizeIrodoriSpeechText('……っ', '思わず息をのむ。', '惊讶')
  assert.equal(gasp.skip, false)
  assert.equal(gasp.text, '😮')

  const sob = normalizeIrodoriSpeechText('…………っ！！', '今にも泣き出しそう。', '伤心')
  assert.equal(sob.skip, false)
  assert.equal(sob.text, '😭')

  const pant = normalizeIrodoriSpeechText('……！', '息切れしながら呼吸する。', '')
  assert.equal(pant.skip, false)
  assert.equal(pant.text, '🌬️')

  const sigh = normalizeIrodoriSpeechText('……', '小さくため息をつく。', '平静')
  assert.equal(sigh.skip, false)
  assert.equal(sigh.text, '😮‍💨')

  const emptySilent = normalizeIrodoriSpeechText('……', '', '平静')
  assert.equal(emptySilent.skip, true)
  assert.equal(emptySilent.text, '')

  // Unsafe ASMR emojis stripped and max 2 safe emojis kept
  const budgeted = normalizeIrodoriSpeechText('あははっ🤭🥵、本当に👅？😮‍💨それでね😆😊！')
  assert.equal(budgeted.skip, false)
  assert.ok(!/[🥵👅💋😴🥤🥴👃]/u.test(budgeted.text))
  assert.equal(budgeted.text, 'あははっ🤭、本当に？😮‍💨それでね！')
  assert.equal(enforceIrodoriEmojiBudget('🤭😮‍💨😆😊', 2), '🤭😮‍💨')
})

test('resolveIrodoriVoice locks base ref audio in normal timbre-lock mode and clamps speed', () => {
  const base = {
    refAudioPath: '/main.wav',
    loraAdapter: '/lora',
    caption: '落ち着いた口調。',
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

  // Normal timbre-lock mode: base refAudioPath stays LOCKED, speed clamped to [0.92, 1.08]
  const happyLocked = resolveIrodoriVoice(base, emotions, '开心', {
    timbreLockMode: 'normal',
    lineOverride: { ttsCaption: '若い女性、少し照れながら笑って話す。', ttsSpeed: 1.25 }
  })
  assert.equal(happyLocked.refAudioPath, '/main.wav')
  assert.equal(happyLocked.caption, '少し照れながら笑って話す。')
  assert.equal(happyLocked.speed, 1.08)
  assert.equal(happyLocked.loraAdapter, '/lora')

  // Special scene unlocks emotion refAudioPath and wider speed [0.85, 1.18]
  const happySpecial = resolveIrodoriVoice(base, emotions, '开心', {
    timbreLockMode: 'normal',
    lineOverride: { ttsSpecialScene: true, ttsSpeed: 1.15 }
  })
  assert.equal(happySpecial.refAudioPath, '/happy.wav')
  assert.equal(happySpecial.caption, '嬉しそうに話している。')
  assert.equal(happySpecial.speed, 1.15)

  // timbreLockMode='off' preserves legacy emotion refAudioPath + unclamped speed behavior
  const happyLegacy = resolveIrodoriVoice(base, emotions, '开心', { timbreLockMode: 'off' })
  assert.equal(happyLegacy.refAudioPath, '/happy.wav')
  assert.equal(happyLegacy.caption, '嬉しそうに話している。')
  assert.equal(happyLegacy.speed, 1.15)
  assert.equal(happyLegacy.loraAdapter, '/lora')

  const calm = resolveIrodoriVoice(base, emotions, '平静', { timbreLockMode: 'off' })
  assert.equal(calm.refAudioPath, '/main.wav')
  assert.equal(calm.caption, '落ち着いた口調。')
  assert.equal(calm.speed, 0.95)

  assert.deepEqual(resolveIrodoriVoice(base, emotions, '未知'), base)
  assert.deepEqual(resolveIrodoriVoice(base, emotions, ''), base)
})

test('buildIrodoriSpeechRequest forwards speaker_kv_* and boosts cfg_scale_caption on specialScene', () => {
  const payload = buildIrodoriSpeechRequest(
    '……っ',
    {
      refAudioPath: '/models/mizuki/sad.wav',
      loraAdapter: '/models/mizuki/lora_adapter',
      caption: '少女の低い声で、泣き出しそうに震えながら叫ぶ。'
    },
    {
      ...defaults,
      cfgScaleSpeaker: 4.0,
      speakerKvScale: 1.15,
      speakerKvMinT: 0.9,
      speakerKvMaxLayers: 12,
      timbreLockMode: 'normal',
      specialSceneCfgScaleCaption: 3.6
    },
    1.0,
    {
      ttsSpecialScene: true,
      ttsSpeed: 0.8
    }
  )

  // Bare sokuon guarded into paralinguistic cue (not raw '……っ')
  assert.equal(payload.input, '😭')
  // Speed clamped to specialScene floor 0.85
  assert.equal(payload.speed, 0.85)
  const irodori = payload.irodori
  assert.equal(irodori.speaker_kv_scale, 1.15)
  assert.equal(irodori.speaker_kv_min_t, 0.9)
  assert.equal(irodori.speaker_kv_max_layers, 12)
  assert.equal(irodori.cfg_scale_caption, 3.6)
  // cfg_scale_speaker protected >= 4.5 on special scenes
  assert.equal(irodori.cfg_scale_speaker, 4.5)
  assert.ok(!/少女|低い声/.test(irodori.caption))
  assert.ok(irodori.caption.includes('泣き出しそうに震えながら叫ぶ。'))
})

test('buildIrodoriSpeechRequest never falls back to raw input when normalized text is skipped', () => {
  const silent = buildIrodoriSpeechRequest('……', { refAudioPath: '/main.wav' }, defaults)
  assert.equal(silent.input, '')

  const unsafeOnly = buildIrodoriSpeechRequest('🥵💋', { refAudioPath: '/main.wav' }, defaults)
  assert.equal(unsafeOnly.input, '')
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

test('normalizeIrodoriSpeechText strips joyful emojis on sad/angry lines while preserving ZWJ/VS16', () => {
  const sad = normalizeIrodoriSpeechText(
    '大丈夫だよ😊🤭😮‍💨、本当に😆？🌬️',
    '涙をこらえながら静かに話す。',
    '伤心'
  )
  assert.equal(sad.skip, false)
  assert.ok(!/[😊🤭😆]/u.test(sad.text))
  assert.ok(sad.text.includes('😮‍💨'), 'ZWJ 😮‍💨 must remain intact')
  assert.ok(sad.text.includes('🌬️'), 'VS16 🌬️ must remain intact')

  const angry = normalizeIrodoriSpeechText('冗談じゃないよ😏🎵！😠', '', '生气')
  assert.equal(angry.skip, false)
  assert.ok(!/[😏🎵]/u.test(angry.text))
  assert.ok(angry.text.includes('😠'))
})

test('buildIrodoriSpeechRequest with timbreLockMode=off selects sad.wav and applies cfg_scale_caption + speaker_kv_scale', () => {
  const base = {
    refAudioPath: '/models/mizuki/emotion_refs/main.wav',
    loraAdapter: '/models/mizuki/lora_adapter',
    caption: '落ち着いた口調で話している。'
  }
  const emotions = [
    {
      emotion: '伤心',
      refAudioPath: '/models/mizuki/emotion_refs/sad.wav',
      caption: '悲しげで、今にも泣きそうな声で話している。',
      speed: 0.94
    }
  ]
  const cfg = {
    ...defaults,
    cfgScaleCaption: 3.5,
    cfgScaleSpeaker: 5.0,
    speakerKvScale: 1.15,
    speakerKvMinT: 0.9,
    timbreLockMode: 'off',
    specialSceneCfgScaleCaption: 4.2
  }

  const normalSadVoice = resolveIrodoriVoice(base, emotions, '伤心', {
    timbreLockMode: 'off',
    lineOverride: { ttsCaption: '声を震わせて控えめに話す。', ttsSpeed: 0.94 }
  })
  assert.equal(normalSadVoice.refAudioPath, '/models/mizuki/emotion_refs/sad.wav')
  const normalPayload = buildIrodoriSpeechRequest('🥺 ……もう戻れないんだよ。', normalSadVoice, cfg, 1.0, {
    ttsCaption: '声を震わせて控えめに話す。',
    ttsSpeed: 0.94,
    emotion: '伤心'
  })
  assert.equal(normalPayload.irodori.ref_wav, '/models/mizuki/emotion_refs/sad.wav')
  assert.equal(normalPayload.irodori.cfg_scale_caption, 3.5)
  assert.equal(normalPayload.irodori.speaker_kv_scale, 1.15)
  assert.equal(normalPayload.irodori.cfg_scale_speaker, 5.0)

  const climaxPayload = buildIrodoriSpeechRequest(
    '😭 ボク、もう……耐えられないんだよ……😊',
    normalSadVoice,
    cfg,
    1.0,
    {
      ttsCaption: '涙をこらえきれず、声を震わせて悲痛に訴えかける。',
      ttsSpeed: 0.88,
      ttsSpecialScene: true,
      emotion: '伤心'
    }
  )
  assert.equal(climaxPayload.irodori.ref_wav, '/models/mizuki/emotion_refs/sad.wav')
  assert.equal(climaxPayload.irodori.cfg_scale_caption, 4.2)
  assert.equal(climaxPayload.irodori.cfg_scale_speaker, 5.0)
  assert.ok(!climaxPayload.input.includes('😊'), 'joyful emoji must be stripped on sad line')
  assert.ok(climaxPayload.input.includes('😭'))
})
