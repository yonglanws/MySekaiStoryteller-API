import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { Logger } from 'tslog'
import { resolveIrodoriVoice } from '../../out-host/common/tts/irodori.js'
import {
  createStoryAgentToolkit,
  runAgenticStoryGeneration
} from '../../out-host/host/ai/agentTools.js'
import {
  hasSpokenStageDirectionLeak,
  lintDialogueFidelity,
  repairSpokenStageDirections
} from '../../out-host/host/ai/dialogueLinter.js'
import {
  annotateFacialName,
  isFacialCompatibleWithLine,
  pickNeutralFacial
} from '../../out-host/host/ai/facialSemantics.js'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import {
  applyVoiceDirectionPlan,
  buildCastPrompt,
  buildStagingPrompt,
  composeStory,
  normalizeDirection,
  normalizeStaging,
  normalizeVoiceDirectionPlan
} from '../../out-host/host/ai/staged.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'
import { validateAndFixStory } from '../../out-host/host/ai/validate.js'

function makeView() {
  return new CatalogView({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-tilthead01',
          'w-normal-glad01',
          'w-normal-sigh01'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_smile_05',
          'face_closeeye_01',
          'face_closeeye_02',
          'face_sad_01',
          'face_trouble_01',
          'face_angry_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal_3.0_t04/19ena_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-tilthead01',
          'w-normal-angry01',
          'w-normal-sigh01'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_serious_01',
          'face_trouble_01',
          'face_sad_01',
          'face_angry_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['bg_room.jpg', 'bg_rooftop.jpg'],
    imageDetails: [
      { file: 'bg_room.jpg', name: '房间·夜晚', description: '夜晚的卧室' },
      { file: 'bg_rooftop.jpg', name: '屋顶·白天', description: '学校天台' }
    ],
    voices: [],
    bgm: ['bgm00003.mp3'],
    bgmDetails: [
      { file: 'bgm00003.mp3', name: '日常曲', mood: '日常', description: '轻松的日常配乐' }
    ]
  })
}

const makePlan = (view) => ({
  title: '天台对话',
  event: '瑞希和绘名在天台商量视频分镜',
  logline: '两人在天台讨论剪辑进度',
  outline: ['开头寒暄', '出现分歧', '各自退让'],
  cast: [
    {
      modelId: 1,
      name: '瑞希',
      fullName: '晓山瑞希',
      path: view.models[0].path,
      role: '发起'
    },
    {
      modelId: 2,
      name: '绘名',
      fullName: '东云绘名',
      path: view.models[1].path,
      role: '回应'
    }
  ],
  background: 'bg_rooftop.jpg'
})

test('requirement #1: facial semantics block smile on sad/apologetic lines and stale backfill', () => {
  const view = makeView()
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_smile_01',
      emotion: '伤心',
      content: '对不起，刚才是我说重了。'
    }).ok,
    false
  )
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_smile_01',
      emotion: '平静',
      content: '……才没有觉得开心。'
    }).ok,
    false
  )
  assert.equal(pickNeutralFacial(view.models[0].facials, 'face_smile_01'), 'face_normal_01')
  assert.match(annotateFacialName(undefined, 'face_sad_01'), /低落|失落/)

  const plan = makePlan(view)
  const dialogue = {
    title: '情绪校验',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '太好了，这次分镜终于过了～♪', emotion: '开心' },
      { id: 'l2', speaker: '瑞希', content: '对不起，我还是搞砸了……', emotion: '伤心' }
    ]
  }
  const direction = normalizeDirection(
    {
      lines: [
        { id: 'l1', motion: 'w-normal-glad01', facial: 'face_smile_01' },
        // 只给了 motion、故意漏掉 facial，验证不会盲目沿用上一句的 face_smile_01
        { id: 'l2', motion: 'w-normal-sigh01' }
      ]
    },
    view,
    plan,
    dialogue
  )
  const story = composeStory(view, plan, dialogue, direction)
  const talks = story.snippets.filter((s) => s.type === 'Talk')
  assert.equal(talks.length, 2)
  const l2Act = talks[1].data.actions[0]
  assert.notEqual(l2Act.facial, 'face_smile_01', 'sad line must never inherit previous smile')
})

test('requirement #2: 2-char scene gives both characters body motions without simultaneous at=0 collisions', () => {
  const view = makeView()
  const plan = makePlan(view)
  const dialogue = {
    title: '双人动作交替',
    lines: Array.from({ length: 10 }, (_, idx) => ({
      id: `l${idx + 1}`,
      speaker: idx % 2 === 0 ? '瑞希' : '绘名',
      content: idx % 2 === 0 ? `瑞希的台词第 ${idx + 1} 句。` : `绘名的台词第 ${idx + 1} 句……`
    }))
  }
  // 模拟大模型偷懒：只给瑞希配动作，给绘名 0 动作，同时尝试在 l3 写同瞬 listener 动作
  const direction = normalizeDirection(
    {
      lines: dialogue.lines.map((l, idx) => ({
        id: l.id,
        ...(idx % 2 === 0
          ? { motion: 'w-normal-nod01', facial: 'face_smile_01' }
          : { facial: 'face_serious_01' }),
        ...(idx === 2
          ? { listener: { modelId: 2, motion: 'w-normal-tilthead01', facial: 'face_trouble_01' } }
          : {})
      }))
    },
    view,
    plan,
    dialogue
  )
  const raw = composeStory(view, plan, dialogue, direction)
  const { story } = validateAndFixStory(raw, view)

  // 同句 Talk.actions 绝不出现双人同时刻（<0.25）身体动作碰撞（纯表情听者反应允许在 at=0 共存）
  const talks = story.snippets.filter((s) => s.type === 'Talk')
  for (const talk of talks) {
    const bodyActs = (Array.isArray(talk.data.actions) ? talk.data.actions : []).filter(
      (a) => typeof a.motion === 'string' && a.motion.trim().length > 0
    )
    for (let i = 0; i < bodyActs.length; i++) {
      for (let j = i + 1; j < bodyActs.length; j++) {
        assert.ok(
          Math.abs((bodyActs[i].at ?? 0) - (bodyActs[j].at ?? 0)) >= 0.25,
          'no simultaneous dual-actor body motions inside Talk'
        )
      }
    }
  }

  // 绘名（modelId=2）绝不能全程 0 动作（包含独立 Motion 片段）
  const bodyMotionsByActor = new Map([
    [1, 0],
    [2, 0]
  ])
  for (const snippet of story.snippets) {
    if (snippet.type === 'Talk') {
      for (const act of snippet.data.actions ?? []) {
        if (act.motion)
          bodyMotionsByActor.set(act.modelId, (bodyMotionsByActor.get(act.modelId) ?? 0) + 1)
      }
    } else if (snippet.type === 'Motion' && snippet.data.motion) {
      bodyMotionsByActor.set(
        snippet.data.modelId,
        (bodyMotionsByActor.get(snippet.data.modelId) ?? 0) + 1
      )
    }
  }
  assert.ok(bodyMotionsByActor.get(1) >= 1, 'actor 1 has body motions')
  assert.ok(bodyMotionsByActor.get(2) >= 1, 'actor 2 gets natural motion switches instead of 0')
})

test('requirement #6 & #7: no forced multi-act prompts and 2-char solo Center cutaways work cleanly', () => {
  const view = makeView()
  const plan = makePlan(view)
  const castPrompt = buildCastPrompt(view, {
    scene: '天台闲聊',
    personas: [],
    targetMinutes: 2
  })
  assert.match(castPrompt.user, /只规划 \*\*1 幕（s1）\*\* 即可/)
  assert.doesNotMatch(castPrompt.user, /规划 \*\*2~3 幕/)

  const stagingPrompt = buildStagingPrompt(
    view,
    plan,
    {
      title: 't',
      lines: Array.from({ length: 14 }, (_, i) => ({
        id: `l${i + 1}`,
        speaker: '瑞希',
        content: '嗯'
      }))
    },
    { scene: 't', personas: [], targetMinutes: 2 }
  )
  assert.match(stagingPrompt.user, /短暂切到单人 Center/)
  assert.doesNotMatch(stagingPrompt.user, /双人全片同场铁律/)

  const dialogue = {
    title: '内心留白',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '绘名今天画得怎么样？' },
      { id: 'l2', speaker: '绘名', content: '还差一点呢。' },
      { id: 'l3', speaker: '瑞希', content: '（……其实我有点担心她太拼了）' },
      { id: 'l4', speaker: '绘名', content: '怎么突然不说话了？' }
    ]
  }
  const staging = normalizeStaging(
    {
      scenes: [
        { id: 's1', fromLineId: 'l1', background: 'bg_rooftop.jpg', activeCast: ['瑞希', '绘名'] }
      ],
      events: [
        { lineId: 'l3', stageGroup: { activeCast: ['瑞希'] } },
        { lineId: 'l4', stageGroup: { activeCast: ['瑞希', '绘名'] } }
      ]
    },
    view,
    plan,
    dialogue
  )
  const story = composeStory(
    view,
    plan,
    dialogue,
    normalizeDirection({}, view, plan, dialogue),
    staging
  )
  const { story: fixed } = validateAndFixStory(story, view)
  const soloAppears = fixed.snippets.filter(
    (s) => s.type === 'Move' && s.data?.to?.side === 'Center'
  )
  assert.ok(soloAppears.length >= 1, '2-char solo inner-thought cutaway moves speaker to Center')
})

test('requirement #8: strips spoken parenthetical actions while preserving inner thoughts', () => {
  assert.equal(hasSpokenStageDirectionLeak('（微笑）早上好啊。'), true)
  assert.equal(hasSpokenStageDirectionLeak('这个嘛……（挠头）我也说不准。'), true)
  assert.equal(hasSpokenStageDirectionLeak('（……如果明天不下雨就好了）'), false)

  assert.equal(repairSpokenStageDirections('（微笑）早上好啊。'), '早上好啊。')
  assert.equal(repairSpokenStageDirections('（挠头）这个我再想想。'), '这个我再想想。')
  assert.equal(
    repairSpokenStageDirections('（……如果能早点说出口就好了）'),
    '（……如果能早点说出口就好了）'
  )

  const lint = lintDialogueFidelity(
    {
      title: '括号校验',
      lines: [
        { id: 'l1', speaker: '瑞希', content: '（叹气）真没办法呢。' },
        { id: 'l2', speaker: '瑞希', content: '（……难道她还在在意那件事？）' }
      ]
    },
    makePlan(makeView())
  )
  const leaks = lint.issues.filter((i) => i.code === 'stage_direction_leak')
  assert.equal(leaks.length, 1)
  assert.equal(leaks[0].lineId, 'l1')
})

test('requirement #9: TTS voice refAudioPaths reset + calm specialScene/speed smoothing', () => {
  const resolved = resolveIrodoriVoice(
    {
      refAudioPath: 'refs/base.wav',
      refAudioPaths: ['refs/base1.wav', 'refs/base2.wav']
    },
    [
      {
        emotion: '伤心',
        refAudioPath: 'refs/sad.wav',
        refAudioPaths: [],
        caption: '低声倾诉。',
        speed: 0.94
      }
    ],
    '伤心',
    { lineOverride: { ttsSpecialScene: true } }
  )
  assert.equal(resolved.refAudioPath, 'refs/sad.wav')
  assert.equal(
    resolved.refAudioPaths,
    undefined,
    'single-ref emotion overrides multi-ref base wavs'
  )

  const dialogue = {
    title: '语速平滑',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '今天天气不错呢。' },
      { id: 'l2', speaker: '瑞希', content: '我们去天台吃午饭吧。' }
    ]
  }
  const plan = normalizeVoiceDirectionPlan(
    {
      lines: [
        {
          id: 'l1',
          emotion: '平静',
          ttsCaption: '落ち着いて話す。',
          ttsSpeed: 0.85,
          ttsSpecialScene: true
        },
        {
          id: 'l2',
          emotion: '平静',
          ttsCaption: '穏やかに話す。',
          ttsSpeed: 1.18,
          ttsSpecialScene: false
        }
      ]
    },
    dialogue,
    ['平静', '开心', '伤心']
  )
  const applied = applyVoiceDirectionPlan(dialogue, plan, ['平静', '开心', '伤心'])
  assert.equal(
    applied.lines[0].ttsSpecialScene,
    undefined,
    'calm line without scream/cry drops specialScene'
  )
  assert.ok(
    Math.abs((applied.lines[1].ttsSpeed ?? 1) - (applied.lines[0].ttsSpeed ?? 1)) <= 0.08 + 1e-6,
    'same-speaker calm speed jump is smoothly damped'
  )
})

test('agentic harness: supports native tool_calls and automatic ReAct JSON fallback', async () => {
  const view = makeView()
  const logger = new Logger({ type: 'hidden' })
  const validPayload = {
    models: [
      { id: 1, model: view.models[0].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
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
          facial: 'face_normal_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '今晚也要继续剪视频吗？',
          ttsText: '',
          modelId: 1,
          closeWindowOnFinish: true
        }
      },
      {
        type: 'LayoutClear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          motion: '',
          facial: '',
          moveSpeed: 'Normal'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }

  // 1) 原生 tool_calls 测试：先查表情工具再交付成稿
  let callIndex = 0
  const nativeServer = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    callIndex += 1
    res.setHeader('content-type', 'application/json')
    if (callIndex === 1) {
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
                    id: 'tc_1',
                    type: 'function',
                    function: {
                      name: 'inspect_character_expressions',
                      arguments: JSON.stringify({ modelId: 1, mood: '微笑' })
                    }
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
            message: { role: 'assistant', content: JSON.stringify(validPayload) }
          }
        ]
      })
    )
  })
  nativeServer.listen(0, '127.0.0.1')
  await once(nativeServer, 'listening')
  const nativeUrl = `http://127.0.0.1:${nativeServer.address().port}/v1`
  try {
    const client = new LlmClient(
      {
        enabled: true,
        baseUrl: nativeUrl,
        apiKeyEnv: 'UNSET',
        model: 'mock-agent',
        temperature: 0.4,
        maxTokens: 4000,
        timeoutMs: 5000,
        retries: 0,
        jsonMode: 'auto',
        extraBody: {},
        systemPrompt: '',
        targetMinutes: 1,
        repairRounds: 1,
        pipeline: 'single',
        condenseDialogue: true,
        polishDialogue: false,
        translateForTts: false,
        personas: [],
        personaDirs: [],
        rag: { enabled: false }
      },
      logger
    )
    const res = await runAgenticStoryGeneration({
      llm: client,
      view,
      personas: [],
      scene: '晚上写分镜',
      targetMinutes: 1,
      logger
    })
    assert.equal(res.modeUsed, 'native')
    assert.deepEqual(res.toolCallsUsed, ['inspect_character_expressions'])
    assert.equal(res.story.snippets.filter((s) => s.type === 'Talk').length, 1)
  } finally {
    nativeServer.close()
  }

  // 2) 不支持原生 tool calling 时自动降级至 ReAct JSON 信封协议
  let reactStep = 0
  const fallbackServer = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    res.setHeader('content-type', 'application/json')
    if (body.tools) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
      return
    }
    reactStep += 1
    if (reactStep === 1) {
      res.end(
        JSON.stringify({
          model: 'mock-react',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  tool_call: {
                    name: 'search_assets',
                    arguments: { kind: 'background', query: '夜晚' }
                  }
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
        model: 'mock-react',
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ final: validPayload }) }
          }
        ]
      })
    )
  })
  fallbackServer.listen(0, '127.0.0.1')
  await once(fallbackServer, 'listening')
  const fallbackUrl = `http://127.0.0.1:${fallbackServer.address().port}/v1`
  try {
    const reactSettings = {
      enabled: true,
      baseUrl: fallbackUrl,
      apiKeyEnv: 'UNSET',
      model: 'mock-react',
      temperature: 0.4,
      maxTokens: 4000,
      timeoutMs: 5000,
      retries: 0,
      jsonMode: 'auto',
      extraBody: {},
      systemPrompt: '',
      targetMinutes: 1,
      repairRounds: 1,
      pipeline: 'single',
      condenseDialogue: true,
      polishDialogue: false,
      translateForTts: false,
      personas: [],
      personaDirs: [],
      rag: { enabled: false }
    }
    const reactClient = new LlmClient(reactSettings, logger)
    const reactCatalog = {
      get: () => ({
        models: view.models,
        images: ['bg_room.jpg', 'bg_rooftop.jpg'],
        imageDetails: [{ file: 'bg_room.jpg', name: '房间·夜晚', description: '夜晚的卧室' }],
        voices: [],
        bgm: ['bgm00003.mp3'],
        bgmDetails: []
      })
    }
    const writer = new StoryWriter(reactClient, reactSettings, reactCatalog, logger)
    const out = await writer.generate({
      prompt: '晚上继续工作',
      pipeline: 'agent',
      translateForTts: false
    })
    assert.equal(out.meta.agentMode, 'react-json')
    assert.deepEqual(out.meta.toolCalls, ['search_assets'])
    assert.equal(out.story.snippets.filter((s) => s.type === 'Talk').length, 1)
  } finally {
    fallbackServer.close()
  }

  // 验证 toolkit validate_dialogue_draft 工具本身能准确报告并修复括号动作
  const toolkit = createStoryAgentToolkit({ view, personas: [], logger })
  const checkOut = JSON.parse(
    await toolkit.execute('validate_dialogue_draft', {
      lines: [
        { speaker: '瑞希', content: '（微笑）这就交给我吧。' },
        { speaker: '瑞希', content: '（……其实还是有点不安）' }
      ]
    })
  )
  assert.equal(checkOut.ok, false)
  assert.equal(checkOut.stageDirectionFixes.length, 1)
  assert.equal(checkOut.stageDirectionFixes[0].repaired, '这就交给我吧。')
})

test('agentic harness: stateful outline -> acting advisor -> draft -> critique -> patch -> finalize across >8 steps', async (t) => {
  const view = makeView()
  const logger = new Logger({ type: 'hidden' })
  const toolkit = createStoryAgentToolkit({
    view,
    personas: [],
    emotionLabels: ['平静', '开心', '伤心'],
    logger
  })

  // 1) lookup_character & inspect_character_expressions (both motion and facial with Chinese mood)
  const charRes = JSON.parse(await toolkit.execute('lookup_character', { character: '瑞希' }))
  assert.equal(charRes.characters[0].modelId, 1)

  const exprRes = JSON.parse(
    await toolkit.execute('inspect_character_expressions', {
      modelId: 1,
      mood: '伤心 道歉',
      dialogueLine: '对不起，我还是搞砸了……',
      emotion: '伤心'
    })
  )
  assert.ok(Array.isArray(exprRes.motions) && exprRes.motions.length > 0)
  assert.ok(exprRes.motions.some((m) => m.includes('sigh') || m.includes('叹气')))
  assert.ok(exprRes.recommended && !exprRes.recommended.facials[0].startsWith('face_smile_01'))

  // 2) recommend_acting_for_lines batch advisor
  const batchRes = JSON.parse(
    await toolkit.execute('recommend_acting_for_lines', {
      lines: [
        { id: 'l1', speaker: '瑞希', content: '对不起，昨天是我态度太冲了……', emotion: '伤心' },
        { id: 'l2', speaker: '绘名', content: '……别这么说，其实我也有不对。', emotion: '平静' }
      ]
    })
  )
  assert.equal(batchRes.recommendations.length, 2)
  assert.ok(batchRes.recommendations[0].recommendedFacials.length >= 1)
  assert.ok(batchRes.recommendations[0].recommendedMotions.length >= 1)

  // 3) plan_story_outline warns on unnecessary split with same background/ambient
  const outlineRes = JSON.parse(
    await toolkit.execute('plan_story_outline', {
      title: '天台和解',
      cast: [{ name: '瑞希' }, { name: '绘名' }],
      scenes: [
        { id: 's1', summary: '开头', background: 'bg_rooftop.jpg', ambient: 'normal' },
        { id: 's2', summary: '继续', background: 'bg_rooftop.jpg', ambient: 'normal' }
      ]
    })
  )
  assert.equal(outlineRes.ok, true)
  assert.ok(outlineRes.warnings.some((w) => w.includes('合并为 1 幕')))

  // 4) save_story_draft -> critique_story_draft -> patch_story_draft -> finalize_story_draft
  const flawedDraft = {
    models: [
      { id: 1, model: view.models[0].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 2, model: view.models[1].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_rooftop.jpg' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          motion: '',
          facial: 'face_normal_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'LayoutAppear',
        wait: false,
        delay: 0,
        data: {
          modelId: 2,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Right', offset: 0 },
          motion: 'w-normal-tilthead01',
          facial: 'face_normal_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '对不起，昨天是我太冲动了……',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-glad01', facial: 'face_smile_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '绘名',
          content: '……没关系，我也有不对的地方。',
          emotion: '平静',
          modelId: 2,
          closeWindowOnFinish: true,
          actions: [{ at: 0, modelId: 2, motion: 'w-normal-nod01', facial: 'face_serious_01' }]
        }
      },
      {
        type: 'LayoutClear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          motion: '',
          facial: '',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'LayoutClear',
        wait: false,
        delay: 0,
        data: {
          modelId: 2,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Right', offset: 0 },
          motion: '',
          facial: '',
          moveSpeed: 'Normal'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }
  const saved = JSON.parse(await toolkit.execute('save_story_draft', { story: flawedDraft }))
  assert.equal(saved.draftSaved, true)
  assert.equal(saved.actingPassed, false)
  assert.equal(saved.metrics.facialMismatchCount, 1)
  assert.equal(saved.metrics.motionMismatchCount, 1)
  assert.ok(saved.actingDiagnostics.some((d) => d.snippetIndex === 3 && d.field === 'facial'))

  const critique = JSON.parse(await toolkit.execute('critique_story_draft', {}))
  assert.equal(critique.schemaValid, true)
  assert.equal(critique.readyToFinalize, false)
  assert.equal(critique.facialMismatchCount, 1)
  assert.equal(critique.motionMismatchCount, 1)
  assert.ok(critique.diagnostics.some((d) => d.snippetIndex === 3 && d.field === 'facial'))
  assert.ok(critique.diagnostics.some((d) => d.snippetIndex === 3 && d.field === 'motion'))

  const issuesOnly = JSON.parse(await toolkit.execute('inspect_story_draft', { onlyIssues: true }))
  assert.equal(issuesOnly.matchedCount, 1)
  assert.equal(issuesOnly.slice[0].idx, 3)
  assert.ok(Array.isArray(issuesOnly.slice[0].issues) && issuesOnly.slice[0].issues.length >= 2)

  const inspectOut = JSON.parse(await toolkit.execute('inspect_story_draft', { type: 'Talk' }))
  assert.equal(inspectOut.matchedCount, 2)

  // Batch insert_before@1 + update_acting@3 in the same patch_story_draft call (ascending order):
  // descending index execution prevents index 1 insertion from shifting index 3 target.
  const patched = JSON.parse(
    await toolkit.execute('patch_story_draft', {
      operations: [
        {
          op: 'insert_before',
          index: 1,
          snippet: { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } }
        },
        { op: 'update_acting', index: 3, motion: 'w-normal-sigh01', facial: 'face_sad_01' }
      ]
    })
  )
  assert.equal(patched.patched, true)
  assert.equal(patched.actingPassed, true)
  assert.equal(patched.readyToFinalize, true)

  const postPatchTalks = JSON.parse(await toolkit.execute('inspect_story_draft', { type: 'Talk' }))
  assert.equal(postPatchTalks.slice[0].idx, 4)
  assert.equal(postPatchTalks.slice[0].actions[0].motion, 'w-normal-sigh01')
  assert.equal(postPatchTalks.slice[0].actions[0].facial, 'face_sad_01')

  const finalized = JSON.parse(await toolkit.execute('finalize_story_draft', {}))
  assert.equal(finalized.finalized, true)

  // 5) Multi-step autonomous loop (>8 turns: 10 tool calls + finalize) succeeds with default maxToolTurns=16
  let turn = 0
  const multiStepServer = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    turn += 1
    res.setHeader('content-type', 'application/json')
    const toolPlan = [
      { name: 'lookup_character', args: { character: '瑞希' } },
      { name: 'lookup_character', args: { character: '绘名' } },
      { name: 'search_assets', args: { kind: 'background', query: '天台' } },
      { name: 'search_assets', args: { kind: 'se', query: '脚步' } },
      { name: 'search_official_corpus', args: { query: '天台 瑞希 绘名', stage: 'dialogue' } },
      {
        name: 'plan_story_outline',
        args: { title: '天台', cast: [{ name: '瑞希' }, { name: '绘名' }] }
      },
      { name: 'inspect_character_expressions', args: { modelId: 1, mood: '伤心' } },
      {
        name: 'recommend_acting_for_lines',
        args: { lines: [{ speaker: '瑞希', content: '对不起……', emotion: '伤心' }] }
      },
      { name: 'save_story_draft', args: { story: flawedDraft } },
      {
        name: 'patch_story_draft',
        args: {
          operations: [
            { op: 'update_acting', index: 3, motion: 'w-normal-sigh01', facial: 'face_sad_01' }
          ]
        }
      }
    ]
    if (turn <= toolPlan.length) {
      const step = toolPlan[turn - 1]
      res.end(
        JSON.stringify({
          model: 'mock-multi',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `tc_${turn}`,
                    type: 'function',
                    function: { name: step.name, arguments: JSON.stringify(step.args) }
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
        model: 'mock-multi',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify({ use_saved_draft: true }) }
          }
        ]
      })
    )
  })
  multiStepServer.listen(0, '127.0.0.1')
  await once(multiStepServer, 'listening')
  t.after(() => multiStepServer.close())

  const multiUrl = `http://127.0.0.1:${multiStepServer.address().port}/v1`
  const client = new LlmClient(
    {
      enabled: true,
      baseUrl: multiUrl,
      apiKeyEnv: 'UNSET',
      model: 'mock-multi',
      temperature: 0.4,
      maxTokens: 4000,
      timeoutMs: 5000,
      retries: 0,
      jsonMode: 'off',
      extraBody: {},
      systemPrompt: '',
      targetMinutes: 1,
      repairRounds: 1,
      pipeline: 'agent',
      agentMaxSteps: 16,
      polishDialogue: false,
      translateForTts: false,
      personas: [],
      personaDirs: [],
      rag: { enabled: false }
    },
    logger
  )
  const multiRes = await runAgenticStoryGeneration({
    llm: client,
    view,
    personas: [],
    scene: '瑞希和绘名在天台道歉和解',
    targetMinutes: 1,
    logger
  })
  assert.equal(multiRes.rounds, 11)
  assert.equal(multiRes.toolCallsUsed.length, 10)
  const talks = multiRes.story.snippets.filter((s) => s.type === 'Talk')
  assert.equal(talks[0].data.actions[0].facial, 'face_sad_01')
  assert.equal(talks[0].data.actions[0].motion, 'w-normal-sigh01')
})

test('agentic harness: batched inspect_character_expressions, search_assets, listener recommendation & patch_story_draft listenerAction', async () => {
  const view = makeView()
  const logger = new Logger({ type: 'hidden' })
  const toolkit = createStoryAgentToolkit({
    view,
    personas: [],
    emotionLabels: ['平静', '开心', '伤心', '生气', '惊讶'],
    logger
  })

  // 1) inspect_character_expressions with moods array (1 call for multiple moods)
  const multiMood = JSON.parse(
    await toolkit.execute('inspect_character_expressions', {
      modelId: 1,
      moods: ['伤心', '生气', '开心']
    })
  )
  assert.ok(multiMood.byMood && multiMood.byMood['伤心'] && multiMood.byMood['生气'])
  assert.ok(
    Array.isArray(multiMood.byMood['伤心'].facials) && multiMood.byMood['伤心'].facials.length > 0
  )
  assert.ok(
    Array.isArray(multiMood.byMood['伤心'].motions) && multiMood.byMood['伤心'].motions.length > 0
  )

  // Default overview mode (no mood/moods/dialogueLine) returns grouped byMood in 1 call
  const overview = JSON.parse(
    await toolkit.execute('inspect_character_expressions', { modelId: 1 })
  )
  assert.ok(overview.byMood && overview.byMood['平静'] && overview.byMood['伤心'])

  // 2) search_assets batched kinds + queries in 1 call
  const batchedAssets = JSON.parse(
    await toolkit.execute('search_assets', {
      kinds: ['background', 'bgm', 'se'],
      queries: ['天台', '日常', '脚步']
    })
  )
  assert.ok(Array.isArray(batchedAssets.backgrounds) && batchedAssets.backgrounds.length >= 1)
  assert.ok(Array.isArray(batchedAssets.bgm) && batchedAssets.bgm.length >= 1)
  assert.ok(Array.isArray(batchedAssets.se) && batchedAssets.se.length >= 1)

  // 3) recommend_acting_for_lines with listenerModelId returns official at: 0 facial-only listenerReaction
  const recWithListener = JSON.parse(
    await toolkit.execute('recommend_acting_for_lines', {
      lines: [
        {
          id: 'l1',
          modelId: 1,
          speaker: '瑞希',
          content: '我就觉得快要窒息了。我根本受不了那个样子……！',
          emotion: '伤心',
          listenerModelId: 2
        }
      ]
    })
  )
  assert.equal(recWithListener.recommendations.length, 1)
  const lr = recWithListener.recommendations[0].listenerReaction
  assert.ok(lr, 'should include listenerReaction when listenerModelId is provided')
  assert.equal(lr.modelId, 2)
  assert.equal(lr.suggestedAt, 0, 'official PJSK listener reaction defaults to at: 0 facial-only')
  assert.equal(lr.preferFacialOnly, true)
  assert.ok(Array.isArray(lr.recommendedFacials) && lr.recommendedFacials.length >= 1)

  // 4) patch_story_draft listenerAction keeps clean at: 0 facial-only when speaker already has a body motion at=0
  const draft = {
    models: [
      { id: 1, model: view.models[0].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 2, model: view.models[1].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_rooftop.jpg' }],
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
          motion: '',
          facial: 'face_sad_01',
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
          motion: '',
          facial: 'face_trouble_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '大家一定会为了不伤害我，拼命装作什么都没发生过。',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-sigh01', facial: 'face_sad_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '一想到那样，我就快要窒息了……',
          emotion: '伤心',
          modelId: 1,
          closeWindowOnFinish: true,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-nod01', facial: 'face_trouble_01' }]
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }
  await toolkit.execute('save_story_draft', { story: draft })
  const patched = JSON.parse(
    await toolkit.execute('patch_story_draft', {
      operations: [
        {
          op: 'upsert_listener_action',
          index: 5,
          listenerAction: {
            modelId: 2,
            at: 0, // speaker already has body motion at=0 -> keeps facial-only at=0 without jarring mid-line stagger
            facial: 'face_sad_01',
            motion: 'w-normal-tilthead01'
          }
        }
      ]
    })
  )
  assert.equal(patched.patched, true)
  const inspected = JSON.parse(await toolkit.execute('inspect_story_draft', { type: 'Talk' }))
  const talk2Acts = inspected.slice[1].actions
  assert.equal(talk2Acts.length, 2)
  const listenerAct = talk2Acts.find((a) => a.modelId === 2)
  assert.ok(listenerAct, 'listener action should be present')
  assert.equal(listenerAct.at, 0, `expected official at: 0 facial-only, got ${listenerAct.at}`)
  assert.equal(listenerAct.facial, 'face_sad_01')
  assert.equal(
    listenerAct.motion,
    undefined,
    'clashing listener body motion is stripped so facial-only cleanly coexists at=0'
  )
})
