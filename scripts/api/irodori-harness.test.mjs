import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { Logger } from 'tslog'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'
import { alignStoryTtsEmotionsAndCaptions } from '../../out-host/host/ai/ttsText.js'
import { validateAndFixStory } from '../../out-host/host/ai/validate.js'
import {
  applyVoiceDirectionPlan,
  buildDirectionPrompt,
  buildEmotionPrompt,
  normalizeVoiceDirectionPlan
} from '../../out-host/host/ai/staged.js'
import {
  buildIrodoriSpeechRequest,
  resolveIrodoriVoice
} from '../../out-host/common/tts/irodori.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const catalog = {
  get: () => ({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-smile01'],
        facials: ['face_smile_01', 'face_normal_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2,
        name: '东云绘名',
        shortName: '绘名',
        path: '21ena_normal/21ena_normal.model3.json',
        motions: ['e-normal-default01', 'e-normal-sigh01'],
        facials: ['face_normal_01', 'face_sad_01'],
        defaultMotion: 'e-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_room.jpg'],
    imageDetails: [{ file: 'bg_room.jpg', name: '房间', description: '放学后的教室' }],
    voices: [],
    bgm: ['bgm00003.mp3'],
    bgmDetails: [{ file: 'bgm00003.mp3', name: '日常', description: '轻松的日常场景' }]
  })
}

const plan = {
  title: '天台对话',
  logline: '瑞希和绘名在天台坦诚心事',
  event: '放学后在天台聊起心结',
  background: 'bg_room.jpg',
  cast: [
    { modelId: 1, name: '瑞希', role: '倾诉者' },
    { modelId: 2, name: '绘名', role: '回应者' }
  ],
  outline: ['开场', '坦白', '高潮', '收尾']
}

test('normalizeVoiceDirectionPlan parses per-line voice direction, strips identity words, clamps speed, and caps specialScene <= 15%', () => {
  const lines = Array.from({ length: 10 }, (_, idx) => ({
    id: `l${idx + 1}`,
    speaker: idx % 2 === 0 ? '瑞希' : '绘名',
    content: idx === 7 ? '对不起……我真的做不到！！' : `台词 ${idx + 1}`
  }))
  const dialogue = { title: '测试', lines }
  const labels = ['平静', '开心', '生气', '伤心', '害羞', '惊讶']

  const raw = {
    lines: lines.map((line, idx) => ({
      id: line.id,
      emotion: idx >= 6 ? '伤心' : '平静',
      ttsCaption:
        idx === 7
          ? '若い女性の低い声で、泣き出しそうに震えながら訴えかける。'
          : '落ち着いた、少し迷いを含む口調で話す。',
      ttsSpeed: idx === 7 ? 0.8 : 1.25,
      // Attempt to mark 4/10 (40%) as specialScene -> must be capped to floor(10 * 0.15) = 1
      ttsSpecialScene: idx >= 6
    }))
  }

  const normalized = normalizeVoiceDirectionPlan(raw, dialogue, labels)
  assert.ok(normalized)
  assert.equal(normalized.size, 10)

  const specialIds = [...normalized.entries()]
    .filter(([, entry]) => entry.ttsSpecialScene)
    .map(([id]) => id)
  assert.equal(specialIds.length, 1, 'specialScene must be deterministically capped to <= 15%')
  assert.equal(specialIds[0], 'l8', 'highest-priority dramatic climax line should keep specialScene')

  const climax = normalized.get('l8')
  assert.ok(!/若い女性|低い声/.test(climax.ttsCaption))
  assert.ok(climax.ttsCaption.includes('泣き出しそうに震えながら訴えかける。'))
  assert.equal(climax.ttsSpeed, 0.85, 'specialScene speed clamped to [0.85, 1.18]')

  const downgraded = normalized.get('l7')
  assert.equal(downgraded.ttsSpecialScene, undefined)
  assert.equal(downgraded.ttsSpeed, 1.08, 'downgraded line speed re-clamped to [0.92, 1.08]')
})

test('applyVoiceDirectionPlan preserves per-line ttsCaption while stabilizing coarse emotion', () => {
  const dialogue = {
    title: '测试',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '今天风好大啊。' },
      { id: 'l2', speaker: '绘名', content: '嗯，快点回去吧。' },
      { id: 'l3', speaker: '瑞希', content: '稍微等一下嘛。' },
      { id: 'l4', speaker: '绘名', content: '瑞希！！不要跑！！' }
    ]
  }
  const labels = ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  const voicePlan = normalizeVoiceDirectionPlan(
    {
      lines: [
        { id: 'l1', emotion: '平静', ttsCaption: '少し寂しげに遠くを見ながら呟く。', ttsSpeed: 0.96 },
        { id: 'l2', emotion: '开心', ttsCaption: 'ぶっきらぼうだが気遣う口調で話す。', ttsSpeed: 1.02 },
        { id: 'l3', emotion: '平静', ttsCaption: '控えめに引き止めるように話す。', ttsSpeed: 0.95 },
        { id: 'l4', emotion: '生气', ttsCaption: '切羽詰まった様子で必死に呼び止める。', ttsSpeed: 1.07 }
      ]
    },
    dialogue,
    labels
  )
  const applied = applyVoiceDirectionPlan(dialogue, voicePlan, labels)
  // Coarse emotion A-B-A singleton on l2 smoothed to 平静, but l2's per-line ttsCaption stays intact!
  assert.equal(applied.lines[1].emotion, '平静')
  assert.equal(applied.lines[1].ttsCaption, 'ぶっきらぼうだが気遣う口調で話す。')
  // Strong shout l4 is NOT crushed into 平静
  assert.equal(applied.lines[3].emotion, '生气')

  // buildDirectionPrompt includes ttsCaption so Live2D aligns with vocal acting
  const view = new CatalogView(catalog.get())
  const dirPrompt = buildDirectionPrompt(view, plan, applied, {
    scene: '天台对话',
    personas: [],
    targetMinutes: 1,
    emotionLabels: labels
  })
  assert.ok(dirPrompt.user.includes('[声演:少し寂しげに遠くを見ながら呟く。]'))
  assert.ok(dirPrompt.user.includes('[声演:切羽詰まった様子で必死に呼び止める。]'))
})

test('buildEmotionPrompt instructs per-line voice direction without identity words or calm-fallback on peaks', () => {
  const dialogue = {
    title: '测试',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '……对不起。' },
      { id: 'l2', speaker: '绘名', content: '瑞希！！' }
    ]
  }
  const prompt = buildEmotionPrompt(plan, dialogue, {
    scene: '天台对话',
    personas: [],
    targetMinutes: 1,
    emotionLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  })
  assert.ok(prompt.system.includes('ttsCaption'))
  assert.ok(prompt.system.includes('若い女性'))
  assert.ok(prompt.user.includes('ttsSpecialScene'))
  assert.ok(prompt.user.includes('15%'))
})

test('validateAndFixStory sanitizes ttsCaption, clamps ttsSpeed, caps ttsSpecialScene <= 15%, and enforces ttsText emoji budget', () => {
  const view = new CatalogView(catalog.get())
  const talkSnippets = Array.from({ length: 10 }, (_, idx) => ({
    type: 'Talk',
    wait: true,
    delay: 0,
    data: {
      speaker: '瑞希',
      content: `这是第 ${idx + 1} 句台词。`,
      modelId: 1,
      ttsText:
        idx === 0
          ? 'あははっ🤭🥵、本当に👅？😮‍💨それでね😆😊！'
          : `これは${idx + 1}番目のセリフだよ。`,
      emotion: '开心',
      ttsCaption: 'アニメ声の若い女性、明るく弾むように話している。',
      ttsSpeed: idx < 3 ? 1.5 : 0.7,
      ttsSpecialScene: idx < 3
    }
  }))

  const rawStory = {
    models: [{ id: 1, path: '20mizuki_normal/20mizuki_normal.model3.json', name: '晓山瑞希' }],
    images: [{ name: '房间', image: 'bg_room.jpg' }],
    snippets: [
      { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { image: 'bg_room.jpg' } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: { modelId: 1, from: { side: 'Center', offset: 0 }, to: { side: 'Center', offset: 0 } }
      },
      ...talkSnippets
    ]
  }

  const { story } = validateAndFixStory(rawStory, view, undefined, {
    emotionLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  })
  const talks = story.snippets.filter((s) => s.type === 'Talk')
  assert.equal(talks.length, 10)
  // Unsafe emojis stripped and total emojis <= 2
  assert.ok(!/[🥵👅]/u.test(talks[0].data.ttsText))
  assert.equal(talks[0].data.ttsText, 'あははっ🤭、本当に？😮‍💨それでね！')
  // Identity words stripped from ttsCaption
  assert.ok(!/アニメ声|若い女性/.test(talks[0].data.ttsCaption))
  assert.ok(talks[0].data.ttsCaption.includes('明るく弾むように話している。'))
  // Special scene capped to floor(10 * 0.15) = 1
  const specials = talks.filter((t) => t.data.ttsSpecialScene === true)
  assert.equal(specials.length, 1)
  assert.equal(specials[0].data.ttsSpeed, 1.18)
  // Downgraded special lines clamped to normal speed range [0.92, 1.08]
  assert.equal(talks[1].data.ttsSpeed, 1.08)
  assert.equal(talks[4].data.ttsSpeed, 0.92)
})

test('StoryWriter staged pipeline passes speaker, persona style, emotion, and ttsCaption to ttsTranslator after voiceDirection', async (t) => {
  let translateUserPrompt = ''
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    const user = body.messages.find((m) => m.role === 'user')?.content ?? ''

    let reply
    if (system.includes('第一轮')) {
      reply = plan
    } else if (system.includes('第二轮')) {
      reply = {
        title: '天台对话',
        lines: [
          { id: 'l1', speaker: '瑞希', content: '今天风好大呀。' },
          { id: 'l2', speaker: '绘名', content: '别站在边上，快过来！' }
        ]
      }
    } else if (system.includes('情绪标注员')) {
      reply = {
        lines: [
          {
            id: 'l1',
            emotion: '平静',
            ttsCaption: '少し遠くを見ながら穏やかに呟く。',
            ttsSpeed: 0.96,
            ttsSpecialScene: false
          },
          {
            id: 'l2',
            emotion: '生气',
            ttsCaption: '焦りと心配を込めて早口で呼びかける。',
            ttsSpeed: 1.06,
            ttsSpecialScene: false
          }
        ]
      }
    } else if (system.includes('舞台监督')) {
      reply = {
        scenes: [
          {
            id: 's1',
            fromLineId: 'l1',
            background: 'bg_room.jpg',
            ambient: 'none',
            activeCast: ['瑞希', '绘名'],
            bgm: 'bgm00003.mp3'
          }
        ],
        events: []
      }
    } else if (system.includes('精细演技导演')) {
      reply = {
        background: 'bg_room.jpg',
        bgm: 'bgm00003.mp3',
        lines: [
          { id: 'l1', facial: 'face_smile_01' },
          { id: 'l2', facial: 'face_sad_01' }
        ]
      }
    } else if (system.includes('中日翻译')) {
      translateUserPrompt = user
      reply = ['今日は風が強いね😮‍💨。', '端っこに立たないで、早くこっち来て！']
    } else {
      throw new Error(`unexpected stage: ${system.slice(0, 40)}`)
    }

    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const settings = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKeyEnv: 'MSS_TEST_LLM_KEY',
    model: 'mock-model',
    temperature: 0.8,
    maxTokens: 2048,
    timeoutMs: 10_000,
    retries: 0,
    repairRounds: 0,
    pipeline: 'staged',
    jsonMode: 'off',
    translateForTts: true,
    targetMinutes: 0.2,
    systemPrompt: '',
    personaDirs: [],
    personas: [
      {
        name: '晓山瑞希',
        prompt: '瑞希说话轻快俏皮，自称ボク，常用感叹和尾音。',
        aliases: ['瑞希'],
        group: '25 时'
      }
    ]
  }
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    catalog,
    new Logger({ type: 'hidden' }),
    ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  )

  const { story } = await writer.generate({ prompt: '天台对话', targetMinutes: 0.2 })
  assert.ok(translateUserPrompt.includes('少し遠くを見ながら穏やかに呟く。'))
  assert.ok(translateUserPrompt.includes('瑞希说话轻快俏皮'))

  const talks = story.snippets.filter((s) => s.type === 'Talk')
  assert.equal(talks.length, 2)
  assert.equal(talks[0].data.ttsCaption, '少し遠くを見ながら穏やかに呟く。')
  assert.equal(talks[0].data.ttsSpeed, 0.96)
  assert.equal(talks[0].data.ttsText, '今日は風が強いね😮‍💨。')
  assert.equal(talks[1].data.ttsCaption, '焦りと心配を込めて早口で呼びかける。')
})

test('TTSService forwards ttsCaption/ttsSpeed/ttsSpecialScene and invalidates cache when they change', async () => {
  const renderer = path.join(root, 'src/renderer/src')
  const common = path.join(root, 'src/common')
  const sentPayloads = []

  // Minimal valid 1-sample WAV header so calculateAudioDuration succeeds
  const wav = Buffer.alloc(46)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(38, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24)
  wav.writeUInt32LE(48000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(2, 40)

  const context = vm.createContext({
    console,
    fetch: async (_url, init) => {
      sentPayloads.push(JSON.parse(init.body))
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)
      }
    },
    AbortController,
    TextDecoder,
    URL,
    DataView,
    Uint8Array,
    ArrayBuffer,
    performance: { now: () => 0 },
    Date,
    setTimeout,
    clearTimeout
  })

  class MockLogger {
    info() {}
    error() {}
    debug() {}
    warn() {}
    getSubLogger() {
      return this
    }
  }
  const mocks = new Map([
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new MockLogger() }],
    [
      path.join(common, 'tts/irodori.ts'),
      { buildIrodoriSpeechRequest, resolveIrodoriVoice }
    ]
  ])
  const modules = new Map()
  const compiled = new Map()
  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.join(renderer, relative)
    if (mocks.has(filename)) return mocks.get(filename)
    if (modules.has(filename)) return modules.get(filename)
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require) {\n${
            ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
              compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
              fileName: filename
            }).outputText
          }\n})`,
          { filename }
        )
      )
    }
    const exports = {}
    modules.set(filename, exports)
    const require = (name) => {
      if (mocks.has(name)) return mocks.get(name)
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }

  const { TTSService, DEFAULT_TTS_CONFIG } = load('services/TTSService.ts')
  const service = new TTSService({
    ...DEFAULT_TTS_CONFIG,
    enabled: true,
    provider: 'irodori',
    apiBaseUrl: 'http://127.0.0.1:8088',
    defaultRefAudioPath: '/main.wav'
  })
  service.setCharacterVoice('瑞希', {
    characterName: '瑞希',
    refAudioPath: '/main.wav',
    promptText: '',
    promptLang: 'ja',
    emotions: [{ emotion: '伤心', refAudioPath: '/sad.wav', caption: '悲しそう。' }]
  })

  // 1) Normal line: refAudioPath stays locked to /main.wav
  await service.synthesizeSpeech('ごめんね。', '瑞希', undefined, '伤心', {
    ttsCaption: '少し震えながら静かに謝る。',
    ttsSpeed: 0.94,
    ttsSpecialScene: false
  })
  assert.equal(sentPayloads.length, 1)
  assert.equal(sentPayloads[0].irodori.ref_wav, '/main.wav')
  assert.equal(sentPayloads[0].irodori.caption, '少し震えながら静かに謝る。')
  assert.equal(sentPayloads[0].speed, 0.94)
  assert.equal(sentPayloads[0].irodori.speaker_kv_scale, 1.15)
  assert.equal(sentPayloads[0].irodori.speaker_kv_min_t, 0.9)

  // 2) Same parameters hit cache (no second fetch)
  await service.synthesizeSpeech('ごめんね。', '瑞希', undefined, '伤心', {
    ttsCaption: '少し震えながら静かに謝る。',
    ttsSpeed: 0.94,
    ttsSpecialScene: false
  })
  assert.equal(sentPayloads.length, 1)

  // 3) Changing ttsCaption or ttsSpecialScene invalidates cache and unlocks /sad.wav
  await service.synthesizeSpeech('ごめんね。', '瑞希', undefined, '伤心', {
    ttsCaption: '涙をこらえきれず声を詰まらせて謝る。',
    ttsSpeed: 0.88,
    ttsSpecialScene: true
  })
  assert.equal(sentPayloads.length, 2)
  assert.equal(sentPayloads[1].irodori.ref_wav, '/sad.wav')
  assert.equal(sentPayloads[1].irodori.cfg_scale_caption, 3.6)
  assert.equal(sentPayloads[1].speed, 0.88)
})

test('alignStoryTtsEmotionsAndCaptions repairs crying-scene emotion, emojis, captions, and specialScene', () => {
  const labels = ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  const story = {
    models: [
      { id: 1, model: '20mizuki_normal/20mizuki_normal.model3.json', normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 2, model: '21ena_normal/21ena_normal.model3.json', normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_room.jpg' }],
    snippets: [
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '绘名',
          modelId: 2,
          content: '呼……总算追上你了……',
          emotion: '平静',
          ttsText: '😮‍💨 ふぅ……やっと追いついた……',
          actions: [{ at: 0, modelId: 2, facial: 'face_trouble_01', motion: 'e-normal-sigh01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          modelId: 1,
          content: '……对不起，绘名。',
          emotion: '伤心',
          ttsText: '🥺 ……ごめんね、絵名。',
          actions: [{ at: 0, modelId: 1, facial: 'face_nhisad_02', motion: 'w-normal-sad01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          modelId: 1,
          content: '没关系的。我都知道。',
          emotion: '平静',
          ttsText: '大丈夫だよ😊。ボク、わかってるから。',
          actions: [{ at: 0, modelId: 1, facial: 'face_closeeye_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          modelId: 1,
          content: '……回不去了，绘名。',
          emotion: '伤心',
          ttsText: '🐢 ……もう戻れないんだよ、絵名。',
          actions: [{ at: 0, modelId: 1, facial: 'face_sad_06' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '绘名',
          modelId: 2,
          content: '瑞希就是瑞希啊。你是我最重要的朋友……',
          emotion: '伤心',
          ttsText: '瑞希は瑞希だよ🤭。私にとって、一番大切な友達なのに……',
          actions: [{ at: 0, modelId: 2, facial: 'face_cry_03', motion: 'w-normal-trouble01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          modelId: 1,
          content: '可窗户纸一旦破了，我就再也没办法安心笑出来了。',
          emotion: '平静',
          ttsText: 'でも、一度知られてしまったら……😮‍💨 もう、安心して笑うことなんてできないんだ。',
          actions: [{ at: 0, modelId: 1, facial: 'face_closeeye_01', motion: 'w-normal-sigh01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '绘名',
          modelId: 2,
          content: '瑞希——！！',
          emotion: '伤心',
          ttsText: '瑞希ぃ——！！',
          actions: [{ at: 0, modelId: 2, facial: 'face_cry_03', motion: 'w-normal-sad01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '绘名',
          modelId: 2,
          content: '…………',
          emotion: '伤心',
          ttsText: '',
          actions: [{ at: 0, modelId: 2, facial: 'face_cry_02' }]
        }
      }
    ]
  }

  const res = alignStoryTtsEmotionsAndCaptions(story, { emotionLabels: labels })
  assert.ok(res.updatedEmotions >= 2)
  assert.ok(res.updatedCaptions >= 6)
  assert.ok(res.updatedEmojis >= 3)

  const talks = story.snippets.map((s) => s.data)
  // Neutral sigh before sad run stays 平静 with 😮‍💨 intact
  assert.equal(talks[0].emotion, '平静')
  assert.ok(talks[0].ttsText.includes('😮‍💨'))
  // Misplaced 平静 inside sad run upgraded to 伤心, joyful 😊 stripped, 🥺 anchored
  assert.equal(talks[2].emotion, '伤心')
  assert.ok(!/[😊🤭😆😏🫶🎵]/u.test(talks[2].ttsText))
  assert.ok(/[😭🥺]/u.test(talks[2].ttsText))
  // 🐢-only sad line gets 🥺 while keeping <= 2 emojis
  assert.ok(/[😭🥺]/u.test(talks[3].ttsText))
  assert.ok(talks[3].ttsText.includes('🐢'))
  // face_cry_03 line with 友達 strips 🤭 and adds 🥺/😭
  assert.ok(!talks[4].ttsText.includes('🤭'))
  assert.ok(/[😭🥺]/u.test(talks[4].ttsText))
  // ZWJ 😮‍💨 preserved on sigh-resignation line upgraded to 伤心
  assert.equal(talks[5].emotion, '伤心')
  assert.ok(talks[5].ttsText.includes('😮‍💨'))
  // Peak cry shout gets 😭 + ttsSpecialScene (<= floor(8 * 0.15) = 1)
  assert.ok(talks[6].ttsText.includes('😭'))
  assert.equal(talks[6].ttsSpecialScene, true)
  const specialCount = talks.filter((t) => t.ttsSpecialScene === true).length
  assert.equal(specialCount, 1)
  // All verbal lines receive non-empty identity-free Japanese ttsCaption
  for (const t of talks.slice(0, 7)) {
    assert.ok(typeof t.ttsCaption === 'string' && t.ttsCaption.length > 0)
    assert.ok(!/若い女性|少女|少年|低い声|高い声/.test(t.ttsCaption))
  }
  // Bare punctuation line keeps empty ttsText
  assert.equal(talks[7].ttsText, '')
})

test('StoryWriter native agent pipeline enforces crying TTS emotions, captions, and zero happy emojis', async (t) => {
  const labels = ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  const agentDraft = {
    models: [
      { id: 1, model: '20mizuki_normal/20mizuki_normal.model3.json', normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 2, model: '21ena_normal/21ena_normal.model3.json', normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_room.jpg' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          motion: 'w-normal-default01',
          facial: 'face_normal_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 2,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Right', offset: 0 },
          motion: 'e-normal-default01',
          facial: 'face_sad_01',
          moveSpeed: 'Normal'
        }
      },
      ...Array.from({ length: 7 }, (_, i) => ({
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: i % 2 === 0 ? '瑞希' : '绘名',
          modelId: i % 2 === 0 ? 1 : 2,
          content:
            i === 2
              ? '没关系的。我都知道。'
              : i === 6
                ? '瑞希——！！别走啊！！'
                : '对不起……我真的回不去了。',
          emotion: i === 2 ? '平静' : '伤心',
          actions: [
            {
              at: 0,
              modelId: i % 2 === 0 ? 1 : 2,
              facial: 'face_sad_01',
              motion: i % 2 === 0 ? 'w-normal-nod01' : 'e-normal-sigh01'
            }
          ]
        }
      }))
    ]
  }

  let translatePrompt = ''
  let turn = 0
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    const user = body.messages.find((m) => m.role === 'user')?.content ?? ''

    let message
    if (system.includes('中日翻译')) {
      translatePrompt = user
      const parsedItems = JSON.parse(user.slice(user.indexOf('[')))
      message = {
        content: JSON.stringify(
          parsedItems.map((it, idx) =>
            idx === 2
              ? '大丈夫だよ😊、ボクわかってるから。'
              : idx === 6
                ? '瑞希ぃ——！！行かないでよ！！'
                : `ごめんね、もう戻れないんだ（${idx}）。`
          )
        )
      }
    } else if (turn === 0) {
      turn += 1
      message = {
        content: null,
        tool_calls: [
          {
            id: 'call_save',
            type: 'function',
            function: {
              name: 'save_story_draft',
              arguments: JSON.stringify(agentDraft)
            }
          }
        ]
      }
    } else {
      turn += 1
      message = {
        content: null,
        tool_calls: [
          {
            id: 'call_final',
            type: 'function',
            function: {
              name: 'finalize_story_draft',
              arguments: JSON.stringify({ note: 'ok' })
            }
          }
        ]
      }
    }

    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'mock-agent-model',
        choices: [{ message }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const settings = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKeyEnv: 'MSS_TEST_LLM_KEY',
    model: 'mock-agent-model',
    temperature: 0.7,
    maxTokens: 4096,
    timeoutMs: 10_000,
    retries: 0,
    repairRounds: 0,
    pipeline: 'agent',
    agentMaxSteps: 8,
    jsonMode: 'off',
    translateForTts: true,
    targetMinutes: 0.3,
    systemPrompt: '',
    personaDirs: [],
    personas: []
  }

  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    catalog,
    new Logger({ type: 'hidden' }),
    labels
  )
  const { story, meta } = await writer.generate({ prompt: '瑞希和绘名哭戏', pipeline: 'agent' })
  assert.equal(meta.agentMode, 'native')
  assert.ok(translatePrompt.includes('ttsCaption'), 'pre-translation alignment passes ttsCaption to translator')

  const talks = story.snippets.filter((s) => s.type === 'Talk')
  assert.equal(talks.length, 7)
  // Misplaced 平静 upgraded to 伤心 before & after translation
  assert.equal(talks[2].data.emotion, '伤心')
  assert.ok(!talks[2].data.ttsText.includes('😊'), 'stray joyful emoji stripped on crying line')
  assert.ok(/[😭🥺]/u.test(talks[2].data.ttsText))
  // Climax line promoted to ttsSpecialScene (<= floor(7 * 0.15) = 1)
  assert.equal(talks[6].data.ttsSpecialScene, true)
  assert.ok(talks[6].data.ttsText.includes('😭'))
  assert.ok(talks.every((tk) => typeof tk.data.ttsCaption === 'string' && tk.data.ttsCaption.length > 0))
})
