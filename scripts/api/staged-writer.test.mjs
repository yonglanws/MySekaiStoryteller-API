import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { Logger } from 'tslog'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import { validateAndFixStory } from '../../out-host/host/ai/validate.js'
import {
  composeStory,
  condenseDialogue,
  normalizeDirection,
  planPresence,
  softenPunctuation,
  stabilizeEmotions
} from '../../out-host/host/ai/staged.js'

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
    images: ['bg_room.jpg', 'bg_night.jpg'],
    imageDetails: [
      { file: 'bg_room.jpg', name: '房间', description: '放学后的教室' },
      { file: 'bg_night.jpg', name: '夜晚房间', description: '夜晚的教室' }
    ],
    voices: [],
    bgm: ['bgm00003.mp3', 'bgm00006.mp3'],
    bgmDetails: [
      { file: 'bgm00003.mp3', name: '日常', description: '轻松的日常场景' },
      { file: 'bgm00006.mp3', name: '安静', description: '安静的夜晚' }
    ]
  })
}

const castReply = {
  title: '放学后',
  logline: '两个人聊下一次练习',
  event: '放学后收拾东西时聊起下次练习',
  background: 'bg_room.jpg',
  cast: [
    { modelId: 1, name: '瑞希', role: '发起' },
    { modelId: 2, name: '绘名', role: '回应' }
  ],
  outline: ['瑞希先开口', '绘名回应', '聊到选曲', '收尾']
}

const dialogueReply = {
  title: '放学后',
  lines: [
    { id: 'l1', speaker: '瑞希', content: '今天也一起练吧。' },
    { id: 'l2', speaker: '绘名', content: '嗯。\n先从哪首开始？' },
    { id: 'l3', speaker: '瑞希', content: '……都可以。' }
  ]
}

const directionReply = {
  background: 'bg_room.jpg',
  bgm: 'bgm00003.mp3',
  bgmStop: true,
  lines: [
    {
      id: 'l1',
      motion: 'w-normal-nod01',
      facial: 'face_smile_01',
      listener: { modelId: 2, facial: 'face_normal_01' }
    },
    { id: 'l2', motion: 'e-normal-sigh01', facial: 'face_sad_01' },
    { id: 'l3', facial: 'face_smile_01' }
  ]
}

async function startMockLlm(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const messages = body.messages ?? []
    const system = messages.find((message) => message.role === 'system')?.content ?? ''
    const user = messages.find((message) => message.role === 'user')?.content ?? ''
    const content = handler({ system, user, messages, index: requests.length - 1 })

    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content: JSON.stringify(content) } }],
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
    pipeline: 'staged',
    jsonMode: 'off',
    translateForTts: true,
    targetMinutes: 3,
    systemPrompt: '',
    personaDirs: [],
    personas: [
      {
        name: '晓山瑞希',
        prompt: '瑞希是 Nightcord 的成员，说话轻快，喜欢逗人。',
        aliases: ['mizuki'],
        group: '25 时'
      },
      {
        name: '东云绘名',
        prompt: '绘名嘴硬心软，常用叹气掩饰关心。',
        aliases: ['ena'],
        group: '25 时'
      }
    ],
    ...overrides
  }
}

function makeWriter(baseUrl, overrides = {}, emotionLabels = []) {
  const settings = makeSettings(baseUrl, overrides)
  return {
    settings,
    writer: new StoryWriter(
      new LlmClient(settings, new Logger({ type: 'hidden' })),
      settings,
      catalog,
      new Logger({ type: 'hidden' }),
      emotionLabels
    )
  }
}

function stageOf(system) {
  if (system.includes('第一轮')) return 'cast'
  if (system.includes('第二轮')) return 'dialogue'
  if (system.includes('情绪标注员')) return 'emotion'
  if (system.includes('第三轮')) return 'direction'
  if (system.includes('中日翻译')) return 'translate'
  return 'unknown'
}

test('staged pipeline keeps dialogue verbatim and applies direction', async (t) => {
  const mock = await startMockLlm(({ system }) => {
    switch (stageOf(system)) {
      case 'cast':
        return castReply
      case 'dialogue':
        return dialogueReply
      case 'direction':
        return directionReply
      case 'translate':
        return ['今日も一緒に練習しよう。', 'うん。\nどの曲から始める？', '……どれでもいいよ。']
      default:
        throw new Error(`unexpected request: ${system.slice(0, 30)}`)
    }
  })
  t.after(() => mock.close())
  process.env.MSS_TEST_LLM_KEY = 'test-key'

  const { writer } = makeWriter(mock.baseUrl)
  const result = await writer.generate({ prompt: '放学后瑞希和绘名聊下次练习', targetMinutes: 0.3 })

  assert.equal(result.meta.pipeline, 'staged')
  assert.equal(result.meta.rounds, 3)
  assert.equal(result.meta.stages.length, 3)
  assert.deepEqual(
    result.meta.stages.map((stage) => stage.stage),
    ['cast', 'dialogue', 'direction']
  )
  assert.ok(result.meta.stages.every((stage) => stage.ok))
  assert.equal(result.meta.title, '放学后')
  assert.deepEqual(
    result.story.models.map((model) => model.id),
    [1, 2]
  )
  assert.equal(result.story.images[0].image, 'bg_room.jpg')

  const bgms = result.story.snippets.filter((snippet) => snippet.type === 'ChangeBgm')
  assert.equal(bgms.length, 2)
  assert.equal(bgms[0].data.file, 'bgm00003.mp3')
  assert.equal(bgms[0].data.stop, false)
  assert.equal(bgms[1].data.file, '')
  assert.equal(bgms[1].data.stop, true)
  assert.equal(result.story.snippets[0].type, 'ChangeBgm')

  const talks = result.story.snippets.filter((snippet) => snippet.type === 'Talk')
  assert.equal(talks.length, 3)
  assert.deepEqual(
    talks.map((talk) => talk.data.content),
    ['今天也一起练吧。', '嗯。\n先从哪首开始？', '……都可以。']
  )
  assert.deepEqual(
    talks.map((talk) => talk.data.speaker),
    ['瑞希', '绘名', '瑞希']
  )
  // 双人戏整场两人同场：第一句的听者反应也保留，所以第一句有说话者+听者两个动作。
  assert.equal(talks[0].data.actions.length, 2)
  assert.equal(talks[0].data.actions[0].modelId, 1)
  assert.equal(talks[0].data.actions[0].motion, 'w-normal-nod01')
  assert.equal(talks[0].data.actions[1].modelId, 2)
  // 第二句只有说话者动作（direction 没给听者反应）
  assert.equal(talks[1].data.actions.length, 1)
  assert.equal(talks[1].data.actions[0].modelId, 2)
  // 第三句只有表情
  assert.equal(talks[2].data.actions.length, 1)
  assert.equal(talks[2].data.actions[0].facial, 'face_smile_01')
  // 官方动作在句首触发，不是台词时长的 10%。
  assert.ok(talks.every((talk) => talk.data.actions.every((action) => action.at === 0)))

  // 双人戏开场两人同时入场、结尾同时退场，整场不再切人。
  const appears = result.story.snippets.filter((snippet) => snippet.type === 'LayoutAppear')
  const clears = result.story.snippets.filter((snippet) => snippet.type === 'LayoutClear')
  assert.equal(appears.length, 2)
  assert.equal(clears.length, 2)
  assert.ok(
    appears.every((snippet) => snippet.data.motion),
    '两个角色都要带入场动作'
  )
  assert.deepEqual(appears.map((snippet) => snippet.data.to.side).sort(), ['Left', 'Right'])

  assert.equal(result.meta.ttsTranslated, 3)
  assert.ok(talks.every((talk) => talk.data.ttsText.length > 0))

  // 台词段只带入选角色的完整人设；表演段带动作清单与逐字台词
  const dialogueRequest = mock.requests.find(
    (request) => stageOf(request.messages[0].content) === 'dialogue'
  )
  assert.ok(dialogueRequest.messages[1].content.includes('瑞希是 Nightcord 的成员'))
  assert.ok(dialogueRequest.messages[1].content.includes('绘名嘴硬心软'))
  assert.ok(!dialogueRequest.messages[1].content.includes('w-normal-nod01'))
  const directionRequest = mock.requests.find(
    (request) => stageOf(request.messages[0].content) === 'direction'
  )
  assert.ok(directionRequest.messages[1].content.includes('w-normal-nod01'))
  assert.ok(directionRequest.messages[1].content.includes('今天也一起练吧。'))
  assert.ok(directionRequest.messages[1].content.includes('可用 BGM'))
  assert.ok(directionRequest.messages[1].content.includes('bgm00003.mp3'))
})

test('staged pipeline falls back to catalog order when casting fails', async (t) => {
  const mock = await startMockLlm(({ system }) => {
    switch (stageOf(system)) {
      case 'cast':
        return { cast: [{ modelId: 999, name: '不存在' }] }
      case 'dialogue':
        return dialogueReply
      case 'direction':
        return { background: 'bg_room.jpg', lines: [] }
      case 'translate':
        return ['a', 'b', 'c']
      default:
        throw new Error('unexpected request')
    }
  })
  t.after(() => mock.close())
  process.env.MSS_TEST_LLM_KEY = 'test-key'

  const { writer } = makeWriter(mock.baseUrl)
  const result = await writer.generate({
    prompt: '两个人聊天',
    translateForTts: false,
    targetMinutes: 0.3
  })

  assert.deepEqual(
    result.story.models.map((model) => model.id),
    [1, 2]
  )
  assert.equal(result.meta.stages[0].stage, 'cast')
  assert.equal(result.meta.stages[0].ok, false)
  assert.ok(result.meta.warnings.some((warning) => warning.includes('按目录顺序回退')))
  // 表演设计为空 → 重写一次仍为空 → 无动作合成
  assert.ok(result.meta.stages.some((stage) => stage.stage === 'direction-repair'))
  assert.ok(result.meta.warnings.some((warning) => warning.includes('表演设计不可用')))
  const talks = result.story.snippets.filter((snippet) => snippet.type === 'Talk')
  assert.equal(talks.length, 3)
  assert.ok(talks.every((talk) => !talk.data.actions || talk.data.actions.length === 0))
})

test('staged pipeline repairs an empty dialogue pass once', async (t) => {
  let dialogueCalls = 0
  const mock = await startMockLlm(({ system }) => {
    switch (stageOf(system)) {
      case 'cast':
        return castReply
      case 'dialogue':
        dialogueCalls += 1
        return dialogueCalls === 1 ? { lines: [] } : dialogueReply
      case 'direction':
        return directionReply
      case 'translate':
        return ['a', 'b', 'c']
      default:
        throw new Error('unexpected request')
    }
  })
  t.after(() => mock.close())
  process.env.MSS_TEST_LLM_KEY = 'test-key'

  const { writer } = makeWriter(mock.baseUrl)
  const result = await writer.generate({
    prompt: '两个人聊天',
    translateForTts: false,
    targetMinutes: 0.3
  })

  assert.deepEqual(
    result.meta.stages.map((stage) => stage.stage),
    ['cast', 'dialogue', 'dialogue-repair', 'direction']
  )
  assert.equal(result.meta.stages[1].ok, false)
  assert.equal(result.story.snippets.filter((snippet) => snippet.type === 'Talk').length, 3)
})

test('staged pipeline labels emotions in a separate stable pass', async (t) => {
  const mock = await startMockLlm(({ system }) => {
    switch (stageOf(system)) {
      case 'cast':
        return castReply
      case 'dialogue':
        return {
          turns: [
            { speaker: '瑞希', lines: ['今天也一起练吧。', '我把副歌重新编了一下。'] },
            { speaker: '绘名', lines: ['……知道了。'] }
          ]
        }
      case 'emotion':
        return {
          segments: [
            { from: 'l1', to: 'l2', emotion: '开心' },
            { from: 'l3', to: 'l3', emotion: '开心' }
          ]
        }
      case 'direction':
        return directionReply
      case 'translate':
        return ['a', 'b', 'c']
      default:
        throw new Error('unexpected request')
    }
  })
  t.after(() => mock.close())
  process.env.MSS_TEST_LLM_KEY = 'test-key'

  const { writer } = makeWriter(mock.baseUrl, {}, ['平静', '开心'])
  const result = await writer.generate({
    prompt: '两个人聊天',
    translateForTts: false,
    targetMinutes: 0.3
  })

  const talks = result.story.snippets.filter((snippet) => snippet.type === 'Talk')
  // 情绪段整段继承，不按句抖动
  assert.deepEqual(
    talks.map((talk) => talk.data.emotion),
    ['开心', '开心', '开心']
  )
  const stageNames = result.meta.stages.map((stage) => stage.stage)
  assert.ok(stageNames.includes('emotion'))
  const emotionRequest = mock.requests.find(
    (request) => stageOf(request.messages[0].content) === 'emotion'
  )
  assert.ok(emotionRequest.messages[1].content.includes('平静、开心'))
  const dialogueRequest = mock.requests.find(
    (request) => stageOf(request.messages[0].content) === 'dialogue'
  )
  assert.ok(!dialogueRequest.messages[1].content.includes('每条台词增加 emotion'))
})

test('stabilizeEmotions merges short runs and drops unknown labels', () => {
  const dialogue = {
    title: '',
    lines: [
      { id: 'l1', speaker: 'A', content: '一' },
      { id: 'l2', speaker: 'A', content: '二' },
      { id: 'l3', speaker: 'B', content: '三' },
      { id: 'l4', speaker: 'B', content: '四' },
      { id: 'l5', speaker: 'A', content: '五' },
      { id: 'l6', speaker: 'A', content: '六' },
      { id: 'l7', speaker: 'A', content: '七' },
      { id: 'l8', speaker: 'A', content: '八' }
    ]
  }
  const plan = new Map([
    ['l1', '平静'],
    ['l2', '兴奋'],
    ['l3', '平静'],
    ['l4', '平静'],
    ['l5', '伤心'],
    ['l6', '伤心'],
    ['l7', '伤心'],
    ['l8', '伤心']
  ])
  const stable = stabilizeEmotions(dialogue, plan, ['平静', '开心', '伤心'])
  const values = dialogue.lines.map((line) => stable.get(line.id))
  // 未知标签「兴奋」被清掉，不产生新的情绪段
  assert.deepEqual(values, ['平静', '平静', '平静', '平静', '伤心', '伤心', '伤心', '伤心'])

  // 单独一行的「开心」夹在两段平静之间：并回前一段，避免一句一换音色
  const shortDialogue = {
    title: '',
    lines: Array.from({ length: 9 }, (_, index) => ({
      id: `l${index + 1}`,
      speaker: index % 2 === 0 ? 'A' : 'B',
      content: '句'
    }))
  }
  const shortPlan = new Map(shortDialogue.lines.map((line) => [line.id, '平静']))
  shortPlan.set('l7', '开心')
  const shortStable = stabilizeEmotions(shortDialogue, shortPlan, ['平静', '开心'])
  assert.deepEqual(
    shortDialogue.lines.map((line) => shortStable.get(line.id)),
    Array.from({ length: 9 }, () => '平静')
  )
})

test('staged direction drops an unregistered bgm and keeps the story', () => {
  const view = new CatalogView(catalog.get())
  const [first, second] = view.models
  const plan = {
    title: '测试',
    event: '两个人聊下次练习',
    logline: '',
    outline: [],
    cast: [first, second].map((model) => ({
      modelId: model.id,
      name: view.shortName(model),
      fullName: model.name,
      path: model.path,
      role: ''
    })),
    background: 'bg_room.jpg'
  }
  const dialogue = {
    title: '测试',
    lines: [
      { id: 'l1', speaker: plan.cast[0].name, content: '今天也一起练吧。' },
      { id: 'l2', speaker: plan.cast[1].name, content: '嗯。' }
    ]
  }
  const direction = normalizeDirection(
    { background: 'bg_room.jpg', bgm: 'not-registered.mp3', lines: [] },
    view,
    plan,
    dialogue
  )
  assert.equal(direction.bgm, '')
  const story = composeStory(view, plan, dialogue, direction)
  assert.equal(
    story.snippets.some((snippet) => snippet.type === 'ChangeBgm'),
    false
  )
})

test('staged direction swaps bgm once at the requested line', () => {
  const view = new CatalogView(catalog.get())
  const [first, second] = view.models
  const plan = {
    title: '测试',
    event: '从日常聊到夜里',
    logline: '',
    outline: [],
    cast: [first, second].map((model) => ({
      modelId: model.id,
      name: view.shortName(model),
      fullName: model.name,
      path: model.path,
      role: ''
    })),
    background: 'bg_room.jpg'
  }
  const dialogue = {
    title: '测试',
    lines: [
      { id: 'l1', speaker: plan.cast[0].name, content: '今天也一起练吧。' },
      { id: 'l2', speaker: plan.cast[1].name, content: '嗯。' },
      { id: 'l3', speaker: plan.cast[0].name, content: '……不过，已经这么晚了。' },
      { id: 'l4', speaker: plan.cast[1].name, content: '那就明天继续。' }
    ]
  }
  const direction = normalizeDirection(
    {
      background: 'bg_room.jpg',
      bgm: 'bgm00003.mp3',
      bgm2: 'bgm00006.mp3',
      bgm2From: 'l3',
      lines: []
    },
    view,
    plan,
    dialogue
  )
  assert.equal(direction.bgm, 'bgm00003.mp3')
  assert.equal(direction.bgm2, 'bgm00006.mp3')
  assert.equal(direction.bgm2From, 2)

  const story = composeStory(view, plan, dialogue, direction)
  const bgmSnippets = story.snippets.filter((snippet) => snippet.type === 'ChangeBgm')
  assert.equal(bgmSnippets.length, 2)
  assert.equal(bgmSnippets[0].data.file, 'bgm00003.mp3')
  assert.equal(bgmSnippets[1].data.file, 'bgm00006.mp3')

  // 第二次换曲必须落在第 3 句之前的 Talk 之后，而不是开场或结尾。
  const talkBefore = story.snippets.filter(
    (snippet) => snippet.type === 'Talk' && snippet.data.content === dialogue.lines[2].content
  )
  assert.equal(talkBefore.length, 1)
  const secondBgmIndex = story.snippets.indexOf(bgmSnippets[1])
  const thirdTalkIndex = story.snippets.indexOf(talkBefore[0])
  assert.ok(
    secondBgmIndex < thirdTalkIndex,
    `第二首 BGM 应在第 3 句之前，实际 ${secondBgmIndex} > ${thirdTalkIndex}`
  )

  // 第一首之前没有第二首；第二首之后不再换回。
  assert.equal(story.snippets.indexOf(bgmSnippets[0]) < secondBgmIndex, true)
})

test('planPresence keeps both characters on stage for the whole duo scene', () => {
  const plan = {
    title: '',
    event: '',
    logline: '',
    outline: [],
    cast: [
      { modelId: 1, name: 'A', fullName: 'A', path: 'a.model3.json', role: '' },
      { modelId: 2, name: 'B', fullName: 'B', path: 'b.model3.json', role: '' }
    ],
    background: ''
  }
  const dialogue = {
    title: '',
    lines: [
      { id: 'l1', speaker: 'A', content: '1' },
      { id: 'l2', speaker: 'A', content: '2' },
      { id: 'l3', speaker: 'B', content: '3' },
      { id: 'l4', speaker: 'B', content: '4' },
      { id: 'l5', speaker: 'A', content: '5' },
      { id: 'l6', speaker: 'A', content: '6' },
      { id: 'l7', speaker: 'A', content: '7' },
      { id: 'l8', speaker: 'B', content: '8' }
    ]
  }
  const direction = {
    background: '',
    bgm: '',
    bgmStop: false,
    lines: [
      { id: 'l1' },
      { id: 'l2' },
      { id: 'l3', listener: { modelId: 1, facial: 'face_normal_01' } },
      { id: 'l4' },
      { id: 'l5' },
      { id: 'l6' },
      { id: 'l7' },
      { id: 'l8' }
    ]
  }
  assert.deepEqual(planPresence(plan, dialogue, direction), [{ from: 0, to: 7, mode: 'duo' }])

  // 听者反应不影响 presence：双人戏始终同场
  const noListener = { ...direction, lines: dialogue.lines.map((line) => ({ id: line.id })) }
  assert.deepEqual(planPresence(plan, dialogue, noListener), [{ from: 0, to: 7, mode: 'duo' }])

  // 单人戏保持 Center，不强行加第二个人
  const soloPlan = { ...plan, cast: [plan.cast[0]] }
  assert.deepEqual(planPresence(soloPlan, dialogue, direction), [
    { from: 0, to: 7, mode: 'solo', speaker: 'A' }
  ])
})

test('condenseDialogue merges same-speaker short lines without changing text', () => {
  const dialogue = {
    title: '',
    lines: [
      { id: 'l1', speaker: 'A', content: '今天的练习，我想先停一下。' },
      { id: 'l2', speaker: 'A', content: '不是不想练，是脑子里一直有别的旋律。' },
      { id: 'l3', speaker: 'B', content: '……你每次这样说，都是要改曲子了。' },
      { id: 'l4', speaker: 'A', content: '嗯。' }
    ]
  }
  const condensed = condenseDialogue(dialogue, 3)
  assert.equal(condensed.lines.length, 3)
  assert.equal(
    condensed.lines[0].content,
    '今天的练习，我想先停一下。不是不想练，是脑子里一直有别的旋律。'
  )
  assert.equal(condensed.lines[1].content, '……你每次这样说，都是要改曲子了。')
  // 短反应不参与合并
  assert.equal(condensed.lines[2].content, '嗯。')
})

test('stabilizeEmotions keeps a calm baseline instead of all-strong labels', () => {
  const dialogue = {
    title: '',
    lines: Array.from({ length: 12 }, (_, index) => ({
      id: `l${index + 1}`,
      speaker: index % 2 === 0 ? 'A' : 'B',
      content: '句'
    }))
  }
  const plan = new Map(dialogue.lines.map((line, index) => [line.id, index < 6 ? '开心' : '生气']))
  const stable = stabilizeEmotions(dialogue, plan, ['平静', '开心', '生气'])
  const values = dialogue.lines.map((line) => stable.get(line.id))
  assert.ok(values.filter((emotion) => emotion === '平静').length >= 3)
})

test('composed staging keeps ambient and second background through validation', () => {
  const view = new CatalogView(catalog.get())
  const [first, second] = view.models
  const plan = {
    title: '',
    event: '',
    logline: '',
    outline: [],
    cast: [first, second].map((model) => ({
      modelId: model.id,
      name: view.shortName(model),
      fullName: model.name,
      path: model.path,
      role: ''
    })),
    background: 'bg_room.jpg'
  }
  const dialogue = {
    title: '',
    lines: Array.from({ length: 10 }, (_, index) => ({
      id: `l${index + 1}`,
      speaker:
        index % 3 === 0
          ? plan.cast[0].name
          : index % 3 === 1
            ? plan.cast[1].name
            : plan.cast[0].name,
      content: '这是第几句台词。',
      emotion: '平静'
    }))
  }
  const direction = normalizeDirection(
    {
      background: 'bg_room.jpg',
      background2: 'bg_night.jpg',
      background2From: 'l6',
      ambient: 'night',
      bgm: '',
      lines: dialogue.lines.map((line) => ({ id: line.id, facial: 'face_normal_01' }))
    },
    view,
    plan,
    dialogue
  )
  const story = composeStory(view, plan, dialogue, direction)
  assert.equal(story.images.length, 2)
  const validated = validateAndFixStory(story, view, new Logger({ type: 'hidden' }))
  const types = validated.story.snippets.map((snippet) => snippet.type)
  assert.ok(types.includes('AmbientColor'))
  assert.ok(
    validated.story.snippets.some(
      (snippet) => snippet.type === 'ChangeBackgroundImage' && snippet.data.imageId === 2
    )
  )
  const appears = validated.story.snippets.filter((snippet) => snippet.type === 'LayoutAppear')
  assert.equal(appears.length, 2, '双人戏只允许开场入场一次')
  assert.ok(
    appears.every((snippet) => snippet.data.motion),
    '两个角色都带入场动作'
  )
  assert.ok(
    appears.every((snippet) => !snippet.data.fadeIn),
    '双人戏不需要原地淡入切人'
  )
  assert.deepEqual(appears.map((snippet) => snippet.data.to.side).sort(), ['Left', 'Right'])
  const clears = validated.story.snippets.filter((snippet) => snippet.type === 'LayoutClear')
  assert.equal(clears.length, 2, '双人戏只在结尾退场一次')
  assert.ok(
    clears.every(
      (snippet) =>
        snippet.data.from.side === snippet.data.to.side &&
        snippet.data.from.offset === snippet.data.to.offset
    ),
    '退场应原地淡出'
  )
  const talkActions = validated.story.snippets
    .filter((snippet) => snippet.type === 'Talk')
    .flatMap((snippet) => snippet.data.actions ?? [])
  assert.ok(
    talkActions.every((action) => action.at === 0),
    '动作必须在句首触发'
  )
})

test('staged pipeline expands a too-short dialogue once', async (t) => {
  let dialogueCalls = 0
  const mock = await startMockLlm(({ system }) => {
    switch (stageOf(system)) {
      case 'cast':
        return castReply
      case 'dialogue':
        dialogueCalls += 1
        if (dialogueCalls === 1) return dialogueReply
        return {
          turns: Array.from({ length: 20 }, (_, index) => ({
            speaker: index % 2 === 0 ? '瑞希' : '绘名',
            lines: [
              `第${index * 2 + 1}句，我们把下次要用的曲子再聊一遍吧。`,
              `第${index * 2 + 2}句，这次我想把节奏放慢一点，应该会更合适。`
            ]
          }))
        }
      case 'direction':
        return directionReply
      case 'translate':
        return ['a', 'b', 'c']
      default:
        throw new Error('unexpected request')
    }
  })
  t.after(() => mock.close())
  process.env.MSS_TEST_LLM_KEY = 'test-key'

  const { writer } = makeWriter(mock.baseUrl)
  const result = await writer.generate({
    prompt: '放学后瑞希和绘名聊下次练习',
    translateForTts: false,
    targetMinutes: 3
  })

  assert.ok(result.meta.stages.some((stage) => stage.stage === 'dialogue-expand'))
  assert.ok(result.meta.warnings.some((warning) => warning.includes('已请求补写')))
  const talks = result.story.snippets.filter((snippet) => snippet.type === 'Talk')
  assert.ok(talks.length >= 30, `expected >=30 talks, got ${talks.length}`)
})

test('softenPunctuation turns some full stops into ellipses without touching words', () => {
  const dialogue = {
    title: '',
    lines: Array.from({ length: 10 }, (_, index) => ({
      id: `l${index + 1}`,
      speaker: index % 2 === 0 ? 'A' : 'B',
      content: `这是第${index + 1}句完整的台词。`,
      emotion: '平静'
    }))
  }
  const softened = softenPunctuation(dialogue, 0.5)
  const ellipsis = softened.lines.filter((line) => line.content.endsWith('……'))
  assert.ok(ellipsis.length >= 5)
  for (const line of softened.lines) {
    assert.equal(
      line.content.replace(/……$/, '。'),
      dialogue.lines.find((item) => item.id === line.id).content
    )
  }
})
