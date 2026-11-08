import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { Logger } from 'tslog'
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
