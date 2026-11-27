import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Logger } from 'tslog'
import { loadHostConfig } from '../../out-host/host/config.js'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
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

  let exploreCallCount = 0
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const sys = body.messages?.[0]?.content ?? ''
    res.setHeader('content-type', 'application/json')
    if (sys.includes('hybrid 探索阶段')) {
      exploreCallCount += 1
      if (Array.isArray(body.tools) && body.tools.length > 0 && exploreCallCount < 3) {
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
                      id: `tc_${exploreCallCount}`,
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
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  researchBrief: '已核实瑞希人设。',
                  optionalPlan: {
                    title: '夜晚聊天',
                    event: '晚上在房间里聊天',
                    background: 'bg_room.jpg',
                    cast: [{ modelId: 1, name: '瑞希', role: '倾诉' }]
                  }
                })
              }
            }
          ]
        })
      )
      return
    }
    if (sys.includes('第二轮：只写台词稿')) {
      res.end(
        JSON.stringify({
          model: 'mock-agent',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  title: '夜晚聊天',
                  turns: [
                    { speaker: '瑞希', lines: ['多步代理完成。', '晚安。'] }
                  ]
                })
              }
            }
          ]
        })
      )
      return
    }
    if (sys.includes('directStaging')) {
      res.end(
        JSON.stringify({
          model: 'mock-agent',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  scenes: [{ id: 's1', fromLineId: 'l1', background: 'bg_room.jpg', ambient: 'night', activeCast: ['瑞希'] }],
                  events: []
                })
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
            message: {
              role: 'assistant',
              content: JSON.stringify({
                background: 'bg_room.jpg',
                lines: [
                  { id: 'l1', facial: 'face_smile_01' },
                  { id: 'l2', motion: 'w-normal-nod01', facial: 'face_smile_01' }
                ]
              })
            }
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
    agentMaxSteps: 12,
    polishDialogue: false,
    targetMinutes: 0.2
  })
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    catalog,
    new Logger({ type: 'hidden' })
  )
  const out = await writer.generate({ prompt: '晚上在房间里聊天', translateForTts: false, targetMinutes: 0.2 })
  assert.equal(out.meta.pipeline, 'agent')
  assert.equal(out.meta.agentMode, 'native')
  assert.equal(out.meta.agentSteps, 3)
  assert.equal(out.meta.toolCalls.length, 2)
  assert.ok(out.story.snippets.some((s) => s.type === 'Talk' && s.data.content === '多步代理完成。'))
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

test('unified pipeline routes agent/hybrid/agentic identically, isolates Phase 2 context, and runs single onlyIssues directorReview', async (t) => {
  const capturedByRun = []
  let currentRun = []
  let exploreTurn = 0
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    currentRun.push(body)
    const sys = body.messages?.[0]?.content ?? ''
    res.setHeader('content-type', 'application/json')
    let message
    if (sys.includes('hybrid 探索阶段')) {
      exploreTurn += 1
      if (exploreTurn % 2 === 1 && Array.isArray(body.tools) && body.tools.length > 0) {
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `tc_${exploreTurn}`,
              type: 'function',
              function: {
                name: 'lookup_character',
                arguments: JSON.stringify({ characters: ['瑞希'] })
              }
            }
          ]
        }
      } else {
        message = {
          role: 'assistant',
          content: JSON.stringify({
            researchBrief: 'PHASE1_SECRET_BRIEF：瑞希夜谈。',
            optionalPlan: {
              title: '夜谈',
              event: '夜晚聊天',
              background: 'bg_room.jpg',
              cast: [{ modelId: 1, name: '瑞希', role: '悲伤倾诉' }]
            }
          })
        }
      }
    } else if (sys.includes('第二轮：只写台词稿')) {
      message = {
        role: 'assistant',
        content: JSON.stringify({
          title: '夜谈',
          turns: [
            { speaker: '瑞希', lines: ['其实今天有点难过……', '……还是先睡吧。'] }
          ]
        })
      }
    } else if (sys.includes('情绪标注员')) {
      message = {
        role: 'assistant',
        content: JSON.stringify({
          lines: [
            { id: 'l1', emotion: '伤心', ttsCaption: '少し沈んだ声で話している。', ttsSpeed: 0.94 },
            { id: 'l2', emotion: '平静', ttsCaption: '静かに落ち着いて話している。', ttsSpeed: 0.98 }
          ]
        })
      }
    } else if (sys.includes('directStaging')) {
      message = {
        role: 'assistant',
        content: JSON.stringify({
          scenes: [{ id: 's1', fromLineId: 'l1', background: 'bg_room.jpg', ambient: 'night', activeCast: ['瑞希'] }],
          events: []
        })
      }
    } else if (sys.includes('精细演技导演')) {
      message = {
        role: 'assistant',
        content: JSON.stringify({
          background: 'bg_room.jpg',
          lines: [
            // Deliberately pick mismatched smile on sad line l1 so audit + onlyIssues flags it
            { id: 'l1', motion: 'w-normal-nod01', facial: 'face_smile_01' },
            { id: 'l2', motion: 'w-normal-default01', facial: 'face_smile_01' }
          ]
        })
      }
    } else if (sys.includes('总导演')) {
      message = {
        role: 'assistant',
        content: JSON.stringify({
          dramaticArc: '情绪克制自然。',
          emotionalContinuityAndVoice: '符合瑞希夜谈口吻。',
          audioAndSeDesign: '补充脚步声效。',
          stageRhythm: '节奏紧凑。',
          actingNaturalness: '修补首句表情冲突。',
          concreteFixes: ['补 PlaySe'],
          operations: [
            {
              op: 'insert_before',
              index: 2,
              snippet: {
                type: 'PlaySe',
                wait: false,
                delay: 0,
                data: { file: 'se_walk_women_001_1.mp3', volume: 0.9 }
              }
            }
          ]
        })
      }
    } else {
      throw new Error(`unexpected stage: ${sys.slice(0, 60)}`)
    }
    res.end(JSON.stringify({ model: 'mock-unified', choices: [{ finish_reason: 'stop', message }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const settings = makeSettings(`http://127.0.0.1:${server.address().port}/v1`, {
    pipeline: 'hybrid',
    polishDialogue: false,
    translateForTts: false,
    targetMinutes: 0.2
  })
  const richCatalog = {
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
          defaultFacial: 'face_normal_01'
        }
      ],
      images: ['bg_room.jpg'],
      imageDetails: [{ file: 'bg_room.jpg', name: '房间', description: '瑞希的房间' }],
      voices: [],
      bgm: [],
      bgmDetails: []
    })
  }
  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    richCatalog,
    new Logger({ type: 'hidden' }),
    ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  )

  const runVariant = async (opts) => {
    currentRun = []
    const res = await writer.generate({
      prompt: '夜晚聊天',
      targetMinutes: 0.2,
      translateForTts: false,
      directorReview: true,
      ...opts
    })
    capturedByRun.push(currentRun)
    return res
  }

  const hybridRes = await runVariant({ pipeline: 'hybrid' })
  const agentRes = await runVariant({ pipeline: 'agent' })
  const agenticRes = await runVariant({ pipeline: 'staged', agentic: true })

  assert.equal(hybridRes.meta.pipeline, 'hybrid')
  assert.equal(agentRes.meta.pipeline, 'agent')
  assert.equal(agenticRes.meta.pipeline, 'agent')
  for (const res of [hybridRes, agentRes, agenticRes]) {
    assert.equal(res.meta.agentMode, 'native')
    assert.deepEqual(res.meta.toolCalls, ['lookup_character'])
    assert.equal(res.meta.agentSteps, 2)
    assert.ok(res.meta.directorReview)
    assert.equal(res.meta.directorReview.appliedOperationsCount, 1)
    assert.equal(res.story.snippets.filter((s) => s.type === 'PlaySe').length, 1)
  }
  assert.deepEqual(hybridRes.story, agentRes.story)

  // Verify strict Phase 2 context isolation & single onlyIssues director review
  const reqs = capturedByRun[0]
  const dialogueReq = reqs.find((r) => (r.messages?.[0]?.content ?? '').includes('第二轮：只写台词稿'))
  assert.ok(dialogueReq)
  assert.equal(dialogueReq.tools, undefined, 'Phase 2 dialogue request must not expose tools')
  assert.ok(
    dialogueReq.messages.every((m) => m.role !== 'tool' && !m.tool_calls),
    'Phase 1 tool messages must be completely discarded before Phase 2'
  )
  assert.ok(
    !dialogueReq.messages.some((m) => String(m.content ?? '').includes('LayoutAppear')),
    'Phase 2 pure dialogue prompt must not contain Live2D JSON boilerplate'
  )

  const reviewReqs = reqs.filter((r) => (r.messages?.[0]?.content ?? '').includes('总导演'))
  assert.equal(reviewReqs.length, 1, 'exactly one unified director-review LLM call')
  const reviewUser = reviewReqs[0].messages[1].content
  assert.ok(reviewUser.includes('onlyIssues'), 'director review includes localized onlyIssues acting hints')
})

test('CatalogView enforces cloudOnly SE prefix fallback, token-by-token outfit resolution, and AbortSignal propagation', async (t) => {
  // 1) cloudOnly SE prefix fallback
  const cloudView = new CatalogView({
    models: [
      {
        id: 4,
        name: '初音未来',
        shortName: '初音',
        cloudId: '21miku_normal',
        path: 'cloud/21miku_normal/21miku_normal.model3.json',
        unit: '虚拟歌手',
        outfitLabel: '原版常服',
        motions: ['w-normal-default01'],
        facials: ['face_normal_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 5,
        name: '初音未来',
        shortName: '初音',
        cloudId: '21miku_night',
        path: 'cloud/21miku_night/21miku_night.model3.json',
        unit: '虚拟歌手',
        outfitLabel: '无人世界(25时风)',
        motions: ['w-normal-default01'],
        facials: ['face_normal_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 6,
        name: '初音未来',
        shortName: '初音',
        cloudId: '21miku_wonder',
        path: 'cloud/21miku_wonder/21miku_wonder.model3.json',
        unit: '虚拟歌手',
        outfitLabel: '奇幻世界(WS风)',
        motions: ['w-normal-default01'],
        facials: ['face_normal_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['cloud/bg01.webp'],
    voices: [],
    bgm: [],
    seDetails: [],
    cloudOnly: true
  })

  assert.equal(cloudView.cloudOnly, true)
  assert.ok(cloudView.seDetailsList().every((s) => s.file.startsWith('cloud/')))
  assert.equal(cloudView.canonicalSe('se00053_b.mp3'), 'cloud/se00053_b.mp3')
  assert.ok(cloudView.seList('脚步', 5).includes('cloud/'))

  // 2) Token-by-token & VS unit-world outfit matching
  const mikuBase = cloudView.modelById(4)
  assert.equal(
    cloudView.resolveOutfitVariant(mikuBase, '25时 深夜在奏家里聊无人世界')?.cloudId,
    '21miku_night'
  )
  assert.equal(
    cloudView.resolveOutfitVariant(mikuBase, 'Wonderlands x Showtime 奇幻乐园排练')?.cloudId,
    '21miku_wonder'
  )

  // 3) AbortSignal propagation in Phase 1 exploration and translateDialogue
  const ac = new AbortController()
  const slowServer = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    ac.abort(new Error('client cancelled'))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: '{}' } }] }))
  })
  slowServer.listen(0, '127.0.0.1')
  await once(slowServer, 'listening')
  t.after(() => slowServer.close())

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const abortSettings = makeSettings(`http://127.0.0.1:${slowServer.address().port}/v1`, {
    pipeline: 'hybrid',
    polishDialogue: false,
    translateForTts: false
  })
  const abortWriter = new StoryWriter(
    new LlmClient(abortSettings, new Logger({ type: 'hidden' })),
    abortSettings,
    catalog,
    new Logger({ type: 'hidden' })
  )
  await assert.rejects(
    abortWriter.generate({ prompt: '取消测试', pipeline: 'hybrid', signal: ac.signal }),
    (err) => err instanceof Error && (err.name === 'AbortError' || /abort|cancel/i.test(err.message))
  )
})

test('main.ts /api/v1/script/generate forwards directorReview boolean for hybrid/agent pipelines', async (t) => {
  const getFreePort = () =>
    new Promise((resolve, reject) => {
      const s = net.createServer()
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        s.close(() => resolve(addr.port))
      })
      s.on('error', reject)
    })

  let sawDirectorReview = false
  const llmServer = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const sys = body.messages?.[0]?.content ?? ''
    res.setHeader('content-type', 'application/json')
    let content
    if (sys.includes('hybrid 探索阶段')) {
      content = JSON.stringify({
        researchBrief: '简短探索。',
        optionalPlan: {
          title: 'HTTP转发测试',
          event: '测试',
          background: 'cloud/bg_01.webp',
          cast: [{ modelId: 1, name: '瑞希', role: '主角' }]
        }
      })
    } else if (sys.includes('第二轮：只写台词稿')) {
      content = JSON.stringify({
        title: 'HTTP转发测试',
        turns: [{ speaker: '瑞希', lines: ['第一句。', '第二句。'] }]
      })
    } else if (sys.includes('directStaging')) {
      content = JSON.stringify({
        scenes: [{ id: 's1', fromLineId: 'l1', background: 'cloud/bg_01.webp', ambient: 'normal', activeCast: ['瑞希'] }],
        events: []
      })
    } else if (sys.includes('总导演')) {
      sawDirectorReview = true
      content = JSON.stringify({
        dramaticArc: 'ok',
        emotionalContinuityAndVoice: 'ok',
        audioAndSeDesign: 'ok',
        stageRhythm: 'ok',
        actingNaturalness: 'ok',
        concreteFixes: [],
        operations: []
      })
    } else {
      content = JSON.stringify({
        background: 'cloud/bg_01.webp',
        lines: [
          { id: 'l1', facial: 'face_normal_01' },
          { id: 'l2', motion: 'w-normal-nod01', facial: 'face_normal_01' }
        ]
      })
    }
    res.end(JSON.stringify({ model: 'mock-http', choices: [{ message: { content } }] }))
  })
  llmServer.listen(0, '127.0.0.1')
  await once(llmServer, 'listening')
  t.after(() => llmServer.close())

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-main-director-'))
  const resDir = path.join(tmpDir, 'resources')
  const webDir = path.join(tmpDir, 'web')
  const outDir = path.join(tmpDir, 'out')
  fs.mkdirSync(path.join(resDir, 'models', 'cloud', '20mizuki_normal'), { recursive: true })
  fs.mkdirSync(path.join(resDir, 'images', 'cloud'), { recursive: true })
  fs.mkdirSync(webDir, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'index.html'), '<html></html>')
  fs.writeFileSync(
    path.join(resDir, 'models', 'cloud', '20mizuki_normal', '20mizuki_normal.model3.json'),
    JSON.stringify({
      Version: 3,
      FileReferences: {
        Motions: {
          'w-normal-default01': [{}],
          'w-normal-nod01': [{}],
          face_normal_01: [{}]
        }
      }
    })
  )
  fs.writeFileSync(
    path.join(resDir, 'models', 'models.yaml'),
    `models:\n  - id: 1\n    name: 晓山瑞希\n    shortName: 瑞希\n    path: cloud/20mizuki_normal/20mizuki_normal.model3.json\n`,
    'utf8'
  )
  fs.writeFileSync(path.join(resDir, 'images', 'cloud', 'bg_01.webp'), 'x')

  const livePort = await getFreePort()
  const mainEntry = path.resolve(process.cwd(), 'out-host', 'host', 'main.js')
  let logs = ''
  let child = null
  try {
    child = spawn(process.execPath, [mainEntry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MSS_TEST_LLM_KEY: 'test-key',
        MSS_HOST: '127.0.0.1',
        MSS_PORT: String(livePort),
        MSS_OUTPUT_DIR: outDir,
        MSS_RESOURCE_DIR: resDir,
        MSS_WEB_RENDERER_DIR: webDir,
        MSS_ASSETS_CLOUD_CATALOG: 'false',
        MSS_ASSETS_CLOUD_ONLY: 'false',
        MSS_LLM_ENABLED: 'true',
        MSS_LLM_BASE_URL: `http://127.0.0.1:${llmServer.address().port}/v1`,
        MSS_LLM_API_KEY_ENV: 'MSS_TEST_LLM_KEY',
        MSS_LLM_MODEL: 'mock-http',
        MSS_LLM_PIPELINE: 'hybrid',
        MSS_LLM_TRANSLATE: 'false',
        MSS_RAG_ENABLED: 'false',
        MSS_TTS_ENABLED: 'false',
        MSS_WORKERS: '1',
        MSS_BROWSER_CHANNELS: '',
        MSS_BROWSER_EXECUTABLE: path.join(tmpDir, 'missing.exe')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (c) => (logs += c.toString()))
    child.stderr?.on('data', (c) => (logs += c.toString()))

    let ready = false
    for (let i = 0; i < 120; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${livePort}/api/v1/health`)
        if (h.ok) {
          ready = true
          break
        }
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(ready, `main.js failed to start:\n${logs}`)

    const genRes = await fetch(`http://127.0.0.1:${livePort}/api/v1/script/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '短剧测试',
        pipeline: 'agent',
        targetMinutes: 0.2,
        translateForTts: false,
        directorReview: true
      })
    })
    const genJson = await genRes.json()
    assert.equal(genRes.status, 200, `${JSON.stringify(genJson)}\n${logs}`)
    assert.equal(genJson.meta.pipeline, 'agent')
    assert.equal(sawDirectorReview, true, 'directorReview boolean must be forwarded to StoryWriter')
    assert.ok(genJson.meta.directorReview)
  } finally {
    if (child && !child.killed) {
      child.kill('SIGKILL')
      await new Promise((r) => setTimeout(r, 150))
    }
    llmServer.closeAllConnections?.()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
