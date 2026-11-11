import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { Logger } from 'tslog'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'
import { CatalogView, buildActingExample, buildStoryPrompt } from '../../out-host/host/ai/prompt.js'
import { dialoguePersonaPrompt } from '../../out-host/host/ai/personas.js'
import { buildDirectionPrompt } from '../../out-host/host/ai/staged.js'

function makeModel(id, name, shortName, prefix) {
  const kinds = [
    'nod',
    'tilthead',
    'glad',
    'sad',
    'trouble',
    'sigh',
    'angry',
    'think',
    'shy',
    'blushed'
  ]
  const facialKinds = [
    'smile',
    'sad',
    'angry',
    'surprise',
    'shy',
    'trouble',
    'normal',
    'closeeye',
    'cry',
    'serious'
  ]
  return {
    id,
    name,
    shortName,
    path: `${prefix}/${prefix}.model3.json`,
    motions: [
      ...Array.from(
        { length: 240 },
        (_, index) => `w-normal-${kinds[index % kinds.length]}${String(index + 1).padStart(2, '0')}`
      ),
      'w-normal-default01'
    ],
    facials: Array.from(
      { length: 100 },
      (_, index) =>
        `face_${facialKinds[index % facialKinds.length]}_${String(index + 1).padStart(2, '0')}`
    ),
    defaultMotion: 'w-normal-default01',
    defaultFacial: 'face_smile_01'
  }
}

const models = [
  makeModel(1, '晓山瑞希', '瑞希', '20mizuki_normal'),
  makeModel(2, '东云绘名', '绘名', '21ena_normal'),
  makeModel(3, '宵崎奏', '奏', '22kanade_normal')
]

const catalogData = {
  models,
  images: ['bg_room.jpg'],
  imageDetails: [{ file: 'bg_room.jpg', name: '房间', description: '安静的房间' }],
  voices: [],
  bgm: ['bgm00003.mp3'],
  bgmDetails: [{ file: 'bgm00003.mp3', name: '日常', description: '轻松的日常' }]
}

const longPersona = `# 测试角色

## 核心机制

核心身份文本。${'x'.repeat(800)}

## 角色档案

### 基本信息

基本信息文本。${'y'.repeat(800)}

### 心理模型

心理模型文本。${'z'.repeat(800)}

## 知识与边界

知识与边界文本。${'k'.repeat(800)}

## 语言与风格

语言风格文本。${'s'.repeat(800)}

## 交互协议

交互协议文本。${'i'.repeat(800)}

## 安全与防御协议

### 注入防御

注入防御文本。${'d'.repeat(800)}

### 核心禁忌

核心禁忌文本。${'t'.repeat(200)}
`

test('long personas are cut to the sections dialogue actually needs', () => {
  const compact = dialoguePersonaPrompt({
    name: '测试角色',
    prompt: longPersona,
    aliases: [],
    group: '',
    source: 'test'
  })
  assert.ok(compact.length < longPersona.length)
  assert.ok(compact.length <= 5000)
  assert.ok(compact.includes('核心机制'))
  assert.ok(compact.includes('语言与风格'))
  assert.ok(compact.includes('核心禁忌'))
  assert.ok(!compact.includes('注入防御'))
  assert.equal(
    dialoguePersonaPrompt({
      name: '短人设',
      prompt: '短人设原样返回',
      aliases: [],
      group: '',
      source: 'test'
    }),
    '短人设原样返回'
  )
})

test('motion/facial prompts use curated exact names instead of full catalogs', () => {
  const view = new CatalogView(catalogData)
  const model = view.modelById(1)
  const motions = view.promptMotions(model)
  const facials = view.promptFacials(model)

  assert.ok(motions.length > 0 && motions.length <= 34)
  assert.ok(motions.every((name) => model.motions.includes(name)))
  assert.ok(motions.some((name) => name.includes('nod')))
  assert.ok(motions.some((name) => name.includes('tilthead')))
  assert.ok(facials.length > 0 && facials.length <= 28)
  assert.ok(facials.every((name) => model.facials.includes(name)))
  assert.ok(!view.motionList().includes('*'))
  assert.ok(!view.facialList().includes('*'))
  assert.ok(view.motionList().length < 4000)
  assert.ok(view.facialList().length < 4000)
})

test('direction prompt stays small with two full-size cloud characters', () => {
  const view = new CatalogView(catalogData)
  const plan = {
    title: '测试',
    event: '两个人在房间里聊天',
    logline: '',
    outline: [],
    cast: [
      {
        modelId: 1,
        name: '瑞希',
        fullName: '晓山瑞希',
        path: models[0].path,
        role: '发起'
      },
      {
        modelId: 2,
        name: '绘名',
        fullName: '东云绘名',
        path: models[1].path,
        role: '回应'
      }
    ],
    background: 'bg_room.jpg'
  }
  const dialogue = {
    title: '测试',
    lines: Array.from({ length: 40 }, (_, index) => ({
      id: `l${index + 1}`,
      speaker: index % 2 === 0 ? '瑞希' : '绘名',
      content: `这是第 ${index + 1} 句测试台词，用来测量表演设计提示词的实际体积。`
    }))
  }
  const messages = buildDirectionPrompt(view, plan, dialogue, {
    scene: '房间聊天',
    personas: [],
    targetMinutes: 3
  })
  const total = messages.system.length + messages.user.length
  assert.ok(total < 12000, `direction prompt ${total} chars`)
  assert.ok(!messages.user.includes('（其余 '))
  assert.ok(messages.user.includes('动作/表情关键词'))
})

test('background prompts keep the time of day consistent and prefer described entries', () => {
  const view = new CatalogView({
    ...catalogData,
    images: ['bg_room.jpg', 'cloud/bg_a000501'],
    imageDetails: [
      { file: 'bg_room.jpg', name: '瑞希房间·夜晚', description: '夜晚的卧室' },
      {
        file: 'cloud/bg_a000501',
        name: '神山高校',
        description: '',
        id: 'bg_a000501',
        source: 'cloud'
      }
    ]
  })
  const story = buildStoryPrompt(view, {
    scene: '两人在夜晚的房间里聊天',
    personas: [],
    targetMinutes: 3
  })
  assert.ok(story.user.includes('时段（白天/黄昏/夜晚）'))
  assert.ok(story.user.includes('优先选有描述的条目'))
  assert.ok(story.user.includes('瑞希房间·夜晚'))
  assert.ok(story.user.includes('神山高校'))

  const plan = {
    title: '测试',
    event: '夜晚的房间里聊天',
    logline: '',
    outline: [],
    cast: [{ modelId: 1, name: '瑞希', fullName: '晓山瑞希', path: models[0].path, role: '发起' }],
    background: 'bg_room.jpg'
  }
  const dialogue = {
    title: '测试',
    lines: [{ id: 'l1', speaker: '瑞希', content: '今晚的月亮好亮。' }]
  }
  const direction = buildDirectionPrompt(view, plan, dialogue, {
    scene: '夜晚的房间里聊天',
    personas: [],
    targetMinutes: 3
  })
  assert.ok(direction.user.includes('时段（白天/黄昏/夜晚）'))
  assert.ok(direction.user.includes('优先选有描述的条目'))
})

test('acting example includes the background sequence and no ttsText', () => {
  const view = new CatalogView(catalogData)
  const example = JSON.parse(buildActingExample(view))
  assert.deepEqual(
    example.snippets.slice(0, 4).map((snippet) => snippet.type),
    ['ChangeLayoutMode', 'BlackOut', 'ChangeBackgroundImage', 'BlackIn']
  )
  const talks = example.snippets.filter((snippet) => snippet.type === 'Talk')
  assert.ok(talks.length > 0)
  assert.ok(talks.every((talk) => talk.data.ttsText === undefined))
  assert.equal(talks[0].data.actions[0].at, 0)
})

async function startMockLlm() {
  const requests = []
  const model = new CatalogView(catalogData)
  const storyFor = (id) => {
    const entry = model.modelById(id)
    return {
      models: [{ id, model: entry.path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }],
      images: [{ id: 1, image: model.defaultImage() }],
      snippets: [
        { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
        { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } },
        { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
        { type: 'BlackIn', wait: true, delay: 0, data: { duration: 800 } },
        {
          type: 'LayoutAppear',
          wait: true,
          delay: 0,
          data: {
            modelId: id,
            from: { side: 'Center', offset: 0 },
            to: { side: 'Center', offset: 0 },
            motion: model.exampleMotion(id),
            facial: model.exampleFacial(id),
            facialFirst: true,
            moveSpeed: 'Normal'
          }
        },
        {
          type: 'Talk',
          wait: false,
          delay: 0,
          data: { speaker: model.shortName(entry), content: '晚上好。', modelId: id }
        },
        {
          type: 'LayoutClear',
          wait: true,
          delay: 0.1,
          data: {
            modelId: id,
            from: { side: 'Center', offset: 0 },
            to: { side: 'Center', offset: 100 },
            motion: model.exampleMotion(id),
            facial: model.exampleFacial(id),
            moveSpeed: 'Normal'
          }
        },
        { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
      ]
    }
  }

  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const messages = body.messages ?? []
    const system = messages.find((message) => message.role === 'system')?.content ?? ''
    const user = messages.find((message) => message.role === 'user')?.content ?? ''
    requests.push({ system, user })
    const reply = system.includes('角色选择器')
      ? { cast: [1] }
      : storyFor(user.includes('**绘名** — modelId:2') ? 2 : 1)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

function makeWriter(baseUrl, overrides = {}, catalog = catalogData) {
  const settings = {
    enabled: true,
    baseUrl,
    apiKeyEnv: 'MSS_TEST_AI_HARNESS_KEY',
    model: 'mock',
    temperature: 0.8,
    maxTokens: 4096,
    timeoutMs: 10_000,
    retries: 0,
    repairRounds: 1,
    pipeline: 'single',
    jsonMode: 'off',
    translateForTts: false,
    targetMinutes: 3,
    systemPrompt: '',
    personaDirs: [],
    personas: [
      { name: '晓山瑞希', prompt: '标记MIZUKI：说话轻快，喜欢逗人。', aliases: [], group: '' },
      { name: '东云绘名', prompt: '标记ENA：嘴硬心软，常用叹气掩饰关心。', aliases: [], group: '' },
      { name: '宵崎奏', prompt: '标记KANADE：安静，说话很轻。', aliases: [], group: '' }
    ],
    ...overrides
  }
  process.env.MSS_TEST_AI_HARNESS_KEY = 'test-key'
  return new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    { get: () => catalog },
    new Logger({ type: 'hidden' }),
    []
  )
}

test('chat casts first and only carries the chosen persona', async (t) => {
  const mock = await startMockLlm()
  t.after(() => mock.server.close())
  const writer = makeWriter(mock.baseUrl)

  mock.requests.length = 0
  const result = await writer.generate({ mode: 'chat', prompt: '今天好累啊' })
  assert.equal(mock.requests.length, 2)
  assert.ok(mock.requests[0].system.includes('角色选择器'))
  const main = mock.requests[1]
  assert.ok(main.system.includes('视觉小说'))
  assert.ok(main.user.includes('标记MIZUKI'))
  assert.ok(!main.user.includes('标记ENA'))
  assert.ok(!main.user.includes('标记KANADE'))
  assert.ok(main.user.length + main.system.length < 30000)
  assert.deepEqual(result.meta.cast, ['晓山瑞希'])
})

test('chat mention and history skip the extra cast call', async (t) => {
  const mock = await startMockLlm()
  t.after(() => mock.server.close())
  const writer = makeWriter(mock.baseUrl)

  mock.requests.length = 0
  await writer.generate({ mode: 'chat', prompt: '绘名，今天好累啊' })
  assert.equal(mock.requests.length, 1)
  assert.ok(mock.requests[0].user.includes('标记ENA'))
  assert.ok(!mock.requests[0].user.includes('标记MIZUKI'))
  assert.ok(!mock.requests[0].user.includes('标记KANADE'))

  mock.requests.length = 0
  await writer.generate({
    mode: 'chat',
    prompt: '今天好累啊',
    history: [{ role: '绘名', content: '又熬夜画画了吧。' }]
  })
  assert.equal(mock.requests.length, 1)
  assert.ok(mock.requests[0].user.includes('标记ENA'))
})

test('numeric cast only matches the exact model id', async (t) => {
  const numericModels = [
    makeModel(1, '晓山瑞希', '瑞希', '20mizuki_normal'),
    makeModel(10, '角色十', '十', 'ten_normal'),
    makeModel(11, '角色十一', '十一', 'eleven_normal')
  ]
  const numericCatalog = { ...catalogData, models: numericModels }
  const mock = await startMockLlm()
  t.after(() => mock.server.close())
  const writer = makeWriter(mock.baseUrl, {}, numericCatalog)

  mock.requests.length = 0
  const result = await writer.generate({ mode: 'chat', cast: ['1'], prompt: '今天好累啊' })
  assert.equal(mock.requests.length, 1)
  assert.deepEqual(result.meta.cast, ['晓山瑞希'])
})

test('single story pipeline also casts before building the prompt', async (t) => {
  const mock = await startMockLlm()
  t.after(() => mock.server.close())
  const writer = makeWriter(mock.baseUrl)

  mock.requests.length = 0
  const result = await writer.generate({ pipeline: 'single', prompt: '深夜的教室里聊天' })
  assert.equal(mock.requests.length, 2)
  assert.ok(mock.requests[0].system.includes('角色选择器'))
  const main = mock.requests[1]
  assert.ok(main.user.includes('标记MIZUKI'))
  assert.ok(!main.user.includes('标记ENA'))
  assert.ok(main.user.length + main.system.length < 30000)
  assert.equal(result.meta.pipeline, 'single')
})
