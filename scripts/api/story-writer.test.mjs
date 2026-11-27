import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { Logger } from 'tslog'
import { loadHostConfig } from '../../out-host/host/config.js'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'

const catalog = {
  get: () => ({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01'],
        facials: ['face_smile_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['bg_room.jpg'],
    imageDetails: [{ file: 'bg_room.jpg', name: '房间', description: '瑞希的房间' }],
    voices: [],
    bgm: [],
    bgmDetails: []
  })
}

const validStory = (content = '晚上好。') => ({
  models: [
    {
      id: 1,
      model: '20mizuki_normal/20mizuki_normal.model3.json',
      normal_scale: 2.1,
      small_scale: 1.8,
      anchor: 0.5
    }
  ],
  images: [{ id: 1, image: 'bg_room.jpg' }],
  snippets: [
    { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
    {
      type: 'LayoutAppear',
      wait: true,
      delay: 0,
      data: {
        modelId: 1,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 0 },
        motion: 'w-normal-nod01',
        facial: 'face_smile_01',
        facialFirst: true,
        moveSpeed: 'Normal'
      }
    },
    {
      type: 'Talk',
      wait: false,
      delay: 0,
      data: { speaker: '瑞希', content, ttsText: '', modelId: 1 }
    },
    {
      type: 'LayoutClear',
      wait: true,
      delay: 0,
      data: {
        modelId: 1,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 100 },
        motion: 'w-normal-nod01',
        facial: 'face_smile_01',
        moveSpeed: 'Normal'
      }
    },
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
  ]
})

const invalidStory = () => ({
  models: validStory().models,
  images: validStory().images,
  snippets: [
    { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
    {
      type: 'Talk',
      wait: false,
      delay: 0,
      data: { speaker: '瑞希', content: '还没入场。', ttsText: '', modelId: 1 }
    },
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
  ]
})

async function startMockLlm() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const messages = body.messages ?? []
    const system = messages.find((message) => message.role === 'system')?.content ?? ''
    const lastUser =
      [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''

    let content
    if (system.includes('中日翻译')) {
      content = JSON.stringify(['こんばんは。'])
    } else if (lastUser.includes('上一次输出无法使用')) {
      content = JSON.stringify(validStory('修复成功。'))
    } else if (messages.length > 2) {
      content = JSON.stringify(validStory('修复成功。'))
    } else {
      content = JSON.stringify(invalidStory())
    }

    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.close()
      await once(server, 'close')
    }
  }
}

function makeSettings(baseUrl, overrides = {}) {
  return {
    enabled: true,
    baseUrl,
    apiKeyEnv: 'MSS_TEST_LLM_KEY',
    model: 'mock-model',
    temperature: 0.8,
    maxTokens: 2048,
    timeoutMs: 10_000,
    retries: 0,
    repairRounds: 1,
    pipeline: 'single',
    jsonMode: 'off',
    translateForTts: false,
    targetMinutes: 3,
    systemPrompt: '',
    personaDirs: [],
    personas: [],
    ...overrides
  }
}

test('repairs an invalid stage and returns a validated story', async (t) => {
  const mock = await startMockLlm()
  t.after(() => mock.close())
  process.env.MSS_TEST_LLM_KEY = 'test-key'

  const settings = makeSettings(mock.baseUrl)
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    catalog,
    new Logger({ type: 'hidden' })
  )
  const result = await writer.generate({ prompt: '晚上在房间里聊天', translateForTts: false })

  assert.equal(result.meta.rounds, 2)
  assert.equal(
    result.story.snippets.find((snippet) => snippet.type === 'Talk').data.content,
    '修复成功。'
  )
  assert.equal(result.story.models[0].id, 1)
  assert.ok(result.story.snippets.some((snippet) => snippet.type === 'LayoutAppear'))
  assert.equal(mock.requests.length, 2)
  assert.equal(mock.requests[0].model, 'mock-model')
})

test('translates missing ttsText in a batch after validation', async (t) => {
  const mock = await startMockLlm()
  t.after(() => mock.close())
  process.env.MSS_TEST_LLM_KEY = 'test-key'

  // 先返回合法剧本，再返回翻译数组
  const original = mock.requests
  const settings = makeSettings(mock.baseUrl)
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    catalog,
    new Logger({ type: 'hidden' })
  )

  // 让第一轮直接合法：服务器对 messages.length==2 仍返回 invalid，
  // 所以这里把 repair 后的结果当作第一轮（repairRounds=0 会失败），改为先修复一次再翻译。
  const result = await writer.generate({ prompt: '晚上在房间里聊天', translateForTts: true })
  const talk = result.story.snippets.find((snippet) => snippet.type === 'Talk')
  assert.equal(talk.data.ttsText, 'こんばんは。')
  assert.equal(result.meta.ttsTranslated, 1)
  assert.ok(original.length >= 3)
})

test('config loads agentMaxSteps with MSS_LLM_AGENT_MAX_STEPS override and passes maxToolTurns to agent pipeline', async (t) => {
  const prev = process.env.MSS_LLM_AGENT_MAX_STEPS
  t.after(() => {
    if (prev === undefined) delete process.env.MSS_LLM_AGENT_MAX_STEPS
    else process.env.MSS_LLM_AGENT_MAX_STEPS = prev
  })
  delete process.env.MSS_LLM_AGENT_MAX_STEPS
  const defaultCfg = loadHostConfig()
  assert.equal(defaultCfg.llm.agentMaxSteps, 16)

  process.env.MSS_LLM_AGENT_MAX_STEPS = '20'
  const envCfg = loadHostConfig()
  assert.equal(envCfg.llm.agentMaxSteps, 20)

  let callCount = 0
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    callCount += 1
    res.setHeader('content-type', 'application/json')
    if (callCount < 4) {
      res.end(
        JSON.stringify({
          model: 'mock-agent',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `tc_${callCount}`,
                    type: 'function',
                    function: { name: 'lookup_character', arguments: '{}' }
                  }
                ]
              }
            }
          ]
        })
      )
      return
    }
    res.end(
      JSON.stringify({
        model: 'mock-agent',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(validStory('多步代理完成。')) }
          }
        ]
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const settings = makeSettings(`http://127.0.0.1:${server.address().port}/v1`, {
    pipeline: 'agent',
    agentMaxSteps: 12
  })
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    catalog,
    new Logger({ type: 'hidden' })
  )
  const out = await writer.generate({ prompt: '晚上在房间里聊天', translateForTts: false })
  assert.equal(out.meta.pipeline, 'agent')
  assert.equal(out.meta.agentMode, 'native')
  assert.equal(out.meta.agentSteps, 4)
  assert.equal(out.meta.toolCalls.length, 3)
})

test('staged pipeline does not waste a dialogue-expand call on 34-line / 680-char 3-minute scripts', async (t) => {
  const twoCastCatalog = {
    get: () => ({
      models: [
        {
          id: 1,
          name: '晓山瑞希',
          shortName: '瑞希',
          path: '20mizuki_normal/20mizuki_normal.model3.json',
          motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-sigh01'],
          facials: ['face_smile_01', 'face_normal_01', 'face_sad_01'],
          defaultMotion: 'w-normal-default01',
          defaultFacial: 'face_smile_01'
        },
        {
          id: 2,
          name: '东云绘名',
          shortName: '绘名',
          path: '21ena_normal/21ena_normal.model3.json',
          motions: ['e-normal-default01', 'e-normal-nod01', 'e-normal-sigh01'],
          facials: ['face_normal_01', 'face_sad_01', 'face_smile_01'],
          defaultMotion: 'e-normal-default01',
          defaultFacial: 'face_normal_01'
        }
      ],
      images: ['bg_room.jpg'],
      imageDetails: [{ file: 'bg_room.jpg', name: '房间', description: '瑞希的房间' }],
      voices: [],
      bgm: ['bgm00003.mp3'],
      bgmDetails: [{ file: 'bgm00003.mp3', name: '日常', description: '轻松的日常' }]
    })
  }
  const lines34 = Array.from({ length: 34 }, (_, idx) => ({
    id: `l${idx + 1}`,
    speaker: idx % 2 === 0 ? '瑞希' : '绘名',
    content: `这是第${String(idx + 1).padStart(2, '0')}句刚好二十个字的对话台词啦。`
  }))
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages?.[0]?.content ?? ''
    let payload
    if (system.includes('第一轮')) {
      payload = {
        title: '夜晚谈心',
        event: '房间谈心',
        logline: '两人聊近况',
        background: 'bg_room.jpg',
        cast: [
          { modelId: 1, name: '瑞希', role: '发起' },
          { modelId: 2, name: '绘名', role: '回应' }
        ],
        outline: ['起', '转', '合']
      }
    } else if (system.includes('第二轮')) {
      payload = {
        title: '夜晚谈心',
        turns: lines34.map((l) => ({ speaker: l.speaker, lines: [l.content] }))
      }
    } else if (system.includes('舞台监督')) {
      payload = {
        scenes: [{ id: 's1', fromLineId: 'l1', background: 'bg_room.jpg', ambient: 'normal', activeCast: ['瑞希', '绘名'], bgm: 'bgm00003.mp3' }],
        events: []
      }
    } else if (system.includes('精细演技导演')) {
      payload = {
        background: 'bg_room.jpg',
        bgm: 'bgm00003.mp3',
        lines: lines34.map((l) => ({ id: l.id, facial: 'face_normal_01' }))
      }
    } else {
      throw new Error(`unexpected stage: ${system.slice(0, 40)}`)
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify(payload) } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const settings = makeSettings(`http://127.0.0.1:${server.address().port}/v1`, {
    pipeline: 'staged',
    targetMinutes: 3,
    translateForTts: false
  })
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    twoCastCatalog,
    new Logger({ type: 'hidden' })
  )
  const out = await writer.generate({ prompt: '夜晚瑞希和绘名聊天', targetMinutes: 3, translateForTts: false })
  assert.ok(!out.meta.stages.some((s) => s.stage === 'dialogue-expand'), '34 lines / 680 chars must not trigger dialogue-expand')
  assert.equal(out.story.snippets.filter((s) => s.type === 'Talk').length, 34)
})

test('staged StoryWriter clears false 伤心 emotion on teasing praise before facial repair runs', async (t) => {
  const twoCastCatalog = {
    get: () => ({
      models: [
        {
          id: 9,
          characterId: 16,
          name: '神代类',
          shortName: '类',
          path: '16rui_normal/16rui_normal.model3.json',
          motions: ['m-normal-nod01'],
          facials: ['face_smile_02', 'face_cry_01', 'face_normal_01'],
          defaultMotion: 'm-normal-nod01',
          defaultFacial: 'face_normal_01'
        },
        {
          id: 18,
          characterId: 13,
          name: '天马司',
          shortName: '司',
          path: '13tsukasa_normal/13tsukasa_normal.model3.json',
          motions: ['m-normal-nod01'],
          facials: ['face_smile_01', 'face_cry_01', 'face_normal_01'],
          defaultMotion: 'm-normal-nod01',
          defaultFacial: 'face_normal_01'
        }
      ],
      images: ['bg_room.jpg'],
      imageDetails: [{ file: 'bg_room.jpg', name: '舞台', description: '奇幻舞台' }],
      voices: [],
      bgm: ['bgm00003.mp3'],
      bgmDetails: [{ file: 'bgm00003.mp3', name: '主题曲', mood: 'warm' }]
    })
  }

  const lines = [
    { id: 'l1', speaker: '司', content: '『别难过，我的伙伴们！就算奔向更遥远的舞台！』', emotion: '伤心', caption: '力強く芝居調で語る。' },
    { id: 'l2', speaker: '司', content: '『所以，笑着送我出发吧！！』', emotion: '伤心', caption: '熱く叫び上げる。' },
    { id: 'l3', speaker: '类', content: '呵呵呵，很有远行的气势嘛，司。', emotion: '伤心', caption: '感心した様子で柔らかく労う。' },
    { id: 'l4', speaker: '司', content: '哈哈哈！那是当然的！', emotion: '开心', caption: '晴れやかに笑う。' }
  ]

  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
    let payload
    if (system.includes('第一轮')) {
      payload = {
        title: '早间排练',
        event: '排练打趣',
        logline: '排练后的打趣',
        background: 'bg_room.jpg',
        cast: [
          { modelId: 9, name: '类', role: '调侃' },
          { modelId: 18, name: '司', role: '排练' }
        ],
        outline: ['排练', '打趣']
      }
    } else if (system.includes('第二轮')) {
      payload = {
        title: '早间排练',
        turns: lines.map((l) => ({ speaker: l.speaker, lines: [l.content] }))
      }
    } else if (system.includes('配音导演兼情绪标注员')) {
      payload = {
        lines: lines.map((l) => ({ id: l.id, emotion: l.emotion, ttsCaption: l.caption, ttsSpeed: 0.95 }))
      }
    } else if (system.includes('舞台监督')) {
      payload = {
        scenes: [{ id: 's1', fromLineId: 'l1', background: 'bg_room.jpg', ambient: 'normal', activeCast: ['类', '司'], bgm: 'bgm00003.mp3' }],
        events: []
      }
    } else if (system.includes('精细演技导演')) {
      payload = {
        background: 'bg_room.jpg',
        bgm: 'bgm00003.mp3',
        lines: [
          { id: 'l1', motion: 'm-normal-nod01', facial: 'face_cry_01' },
          { id: 'l2', motion: 'm-normal-nod01', facial: 'face_cry_01' },
          { id: 'l3', motion: 'm-normal-nod01', facial: 'face_smile_02' },
          { id: 'l4', motion: 'm-normal-nod01', facial: 'face_smile_01' }
        ]
      }
    } else {
      throw new Error(`unexpected stage: ${system.slice(0, 40)}`)
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify(payload) } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const settings = makeSettings(`http://127.0.0.1:${server.address().port}/v1`, {
    pipeline: 'staged',
    targetMinutes: 0.2,
    translateForTts: false
  })
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    twoCastCatalog,
    new Logger({ type: 'hidden' }),
    ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  )
  const out = await writer.generate({ prompt: '奇幻舞台排练', targetMinutes: 0.2, translateForTts: false })
  const talks = out.story.snippets.filter((s) => s.type === 'Talk')
  const ruiLine = talks.find((t) => t.data.content.includes('很有远行的气势嘛'))
  assert.ok(ruiLine)
  assert.equal(ruiLine.data.emotion, '开心')
  const ruiAction = ruiLine.data.actions?.find((a) => a.modelId === 9)
  assert.notEqual(ruiAction?.facial, 'face_cry_01', 'facial must not be forced into face_cry_01 after clearing false 伤心 emotion')
})
