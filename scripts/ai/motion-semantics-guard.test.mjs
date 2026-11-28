import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  inspectModelMotion,
  isMotionCompatibleWithLine,
  isWavingOrBigTheatricalMotion,
  pickMoodMatchedMotion,
  recommendActingForLine
} from '../../out-host/host/ai/facialSemantics.js'
import {
  auditStoryActingAndFidelity,
  enforceOfficialStoryInvariants,
  syncTalkEmotionContinuity
} from '../../out-host/host/ai/officialLinter.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import {
  buildDirectionPrompt,
  buildDirectorReviewPrompt,
  composeStory,
  normalizeCastPlan,
  normalizeDialogue,
  normalizeDirection,
  normalizeStaging
} from '../../out-host/host/ai/staged.js'
import { pickAppearFallbackMotion } from '../../out-host/host/ai/staged/actingHelpers.js'
import { validateAndFixStory } from '../../out-host/host/ai/validate.js'

function makeShinonomeView() {
  return new CatalogView({
    models: [
      {
        id: 2278,
        name: '东云绘名',
        shortName: '绘名',
        path: 'cloud/v2_19ena_casual/19ena_clathes2_4_t07/19ena_clathes2_4_t07.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-nod03',
          'w-normal-tilthead01',
          'w-normal-tilthead02',
          'w-adult-posetilthead01',
          'w-normal-shakehead01',
          'w-normal-shakehead02',
          'w-normal-angry01',
          'w-cute-angry01',
          'w-normal-forward01',
          'w-normal-forward02',
          'w-normal-sad01',
          'w-cool-posesad01',
          'w-normal-trouble01',
          'w-normal-sigh01',
          'w-normal-relief01',
          'w-normal-think01',
          'w-normal-lookaway01',
          'w-normal-shy01',
          'w-normal-blushed01',
          'w-normal-fidget01',
          'w-normal-armescape01l',
          'w-normal-greeting01',
          'w-normal15-greeting',
          'w-adult-shakehand01',
          'w-adult01-shakehand',
          'w-happy01-shakehand'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_angry_01',
          'face_serious_01',
          'face_serious_02',
          'face_sad_01',
          'face_tired_01',
          'face_trouble_01',
          'face_surprise_01',
          'face_shock_01',
          'face_shy_01',
          'face_closeeye_01',
          'face_smallmouth_01',
          'face_cry_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2165,
        name: '东云彰人',
        shortName: '彰人',
        path: 'cloud/v2_11akito_casual/v2_11akito_casual_t12/v2_11akito_casual_t12.model3.json',
        motions: [
          'm-normal-default01',
          'm-normal13-nod',
          'm-normal1416-tiltheadnod',
          'm-normal13-shakehead',
          'm-normal13-angry',
          'm-cool01-disgust',
          'm-normal13-forward',
          'm-normal13-lookdown',
          'm-normal14-lookaround',
          'm-normal13-sigh',
          'm-cool03-trouble',
          'm-proud01-regret',
          'm-proud11-surprise',
          'm-cool08-plan',
          'm-normal-shakehand01',
          'm-normal01-shakehand',
          'm-normal01-shakehandB'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_angry_01',
          'face_serious_01',
          'face_worry_01',
          'face_trouble_01',
          'face_trouble_02',
          'face_surprise_01',
          'face_closeeye_01',
          'face_closeeye_02',
          'face_smallmouth_01',
          'face_sad_01',
          'face_cry_01'
        ],
        defaultMotion: 'm-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['cloud/bg_e001003'],
    imageDetails: [
      { file: 'cloud/bg_e001003', name: '东云家 客厅', description: '深夜的东云家客厅' }
    ],
    voices: [],
    bgm: ['cloud/bgm00054.mp3', 'cloud/bgm00113.mp3'],
    bgmDetails: [
      { file: 'cloud/bgm00054.mp3', name: 'Not Bad Afternoon', description: '轻松斗嘴日常' },
      { file: 'cloud/bgm00113.mp3', name: 'Warm Night', description: '温和缓和夜色' }
    ]
  })
}

test('shakehand/greeting/wave are context-gated greeting motions and plan is playful, not neutral forward', () => {
  for (const waveMot of [
    'w-adult01-shakehand',
    'w-adult-shakehand01',
    'm-normal01-shakehand',
    'm-normal01-shakehandB',
    'w-normal-greeting01',
    'w-normal15-greeting'
  ]) {
    const info = inspectModelMotion(undefined, waveMot)
    assert.equal(info.role, 'greeting', `${waveMot} must classify as greeting`)
    assert.equal(info.contextTag, 'greeting', `${waveMot} must carry greeting contextTag`)
    assert.equal(isWavingOrBigTheatricalMotion(waveMot), true)
  }

  const planInfo = inspectModelMotion(undefined, 'm-cool08-plan')
  assert.equal(planInfo.role, 'playful', 'm-cool08-plan must not classify as neutral forward')

  // Reject waving in angry, fatigue, neutral, and non-greeting cheerful lines
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-adult01-shakehand',
      emotion: '生气',
      content: '就算没写名字，那种金边包装一看就很贵好吗？！'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'm-normal01-shakehand',
      emotion: '平静',
      content: '干嘛啊，大半夜在冰箱前面发什么呆。'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-greeting01',
      emotion: '开心',
      content: '好耶，这个甜点真不错！'
    }).ok,
    false
  )

  // Allow waving when explicitly greeting, saying goodbye, or calling out
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-greeting01',
      emotion: '开心',
      content: '早上好！大家今天来得都好早呀！'
    }).ok,
    true
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'm-normal01-shakehand',
      emotion: '平静',
      content: '那明天见，路上小心啊。'
    }).ok,
    true
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-adult01-shakehand',
      emotion: '开心',
      content: '喂——！我在这边！'
    }).ok,
    true
  )
})

test('pickMoodMatchedMotion diversity never overflows into shy, waving, or scheming motions during anger', () => {
  const view = makeShinonomeView()
  const ena = view.modelById(2278)
  const akito = view.modelById(2165)

  // Heavily penalize the primary angry motions just like validate.ts used to do mid-argument
  const heavyMotionCounts = new Map([
    ['w-normal-angry01', 3],
    ['w-cute-angry01', 3],
    ['w-normal-shakehead01', 3],
    ['w-normal-shakehead02', 3],
    ['w-normal-forward01', 3],
    ['w-normal-forward02', 3]
  ])
  const heavyStemCounts = new Map([
    ['angry', 6],
    ['shakehead', 6],
    ['forward', 6]
  ])

  const pickedAngry = pickMoodMatchedMotion(
    ena.motions,
    'angry_frustration',
    ena.path,
    false,
    ['w-normal-angry01'],
    undefined,
    { motionCounts: heavyMotionCounts, stemCounts: heavyStemCounts }
  )
  assert.ok(
    !/blushed|fidget|armescape|shy|shakehand|greeting|posetilthead|tilthead/i.test(pickedAngry),
    `angry diversity pick must stay in-mood, got: ${pickedAngry}`
  )

  // Bedtime/neutral Akito must never pick shakehand or plan
  const pickedBedtime = pickMoodMatchedMotion(
    akito.motions,
    'neutral',
    akito.path,
    false,
    ['m-normal13-nod'],
    undefined,
    { motionCounts: new Map([['m-normal13-nod', 4]]), stemCounts: new Map([['nod', 4]]) }
  )
  assert.ok(
    !/shakehand|plan|greeting/i.test(pickedBedtime),
    `neutral diversity pick must not pick waving/plan, got: ${pickedBedtime}`
  )

  // Specific line-level rejections matching script_patch.json failures
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-blushed01',
      emotion: '生气',
      content: '那是我特意绕去涩谷排了四十分钟队，才抢到的季节限定焦糖芝士布丁！'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-fidget01',
      emotion: '生气',
      content: '结果你居然一口都不剩全吞了？！'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-sigh01',
      emotion: '生气',
      content: '这像话吗？！你赔我布丁！！'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-adult-posetilthead01',
      emotion: '平静',
      content: '唉……肩膀好酸，那块阴影怎么涂都不对劲……'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'm-cool08-plan',
      emotion: '平静',
      content: '……行了，那我回房了。'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-armescape01l',
      emotion: '平静',
      content: '知道了，烦死了。',
      isListener: true
    }).ok,
    false
  )
})

test('reproduces and repairs all script_patch.json motion/facial bugs across two validation passes', () => {
  const view = makeShinonomeView()

  // Reproduce the exact offending beats from scratch/script_patch.json
  const brokenPatchStory = {
    models: [
      { id: 2278, model: view.models[0].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 2165, model: view.models[1].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'cloud/bg_e001003' }],
    snippets: [
      {
        type: 'ChangeLayoutMode',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { mode: 'Normal' }
      },
      {
        type: 'ChangeBackgroundImage',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { imageId: 1 }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          modelId: 2278,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          motion: 'w-adult01-shakehand',
          facial: 'face_angry_01',
          facialFirst: true,
          moveSpeed: 'Normal',
          hologram: false
        }
      },
      {
        type: 'LayoutAppear',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: {
          modelId: 2165,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Right', offset: 0 },
          motion: 'm-normal01-shakehand',
          facial: 'face_worry_01',
          facialFirst: true,
          moveSpeed: 'Normal',
          hologram: false
        }
      },
      // [7]+[8]: Fatigue complaint with posetilthead + face_smile_01
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '唉……肩膀好酸，\n那块阴影怎么涂都不对劲……',
          emotion: '平静',
          modelId: 2278,
          actions: [{ at: 0, modelId: 2278, facial: 'face_tired_01' }]
        }
      },
      {
        type: 'Motion',
        wait: false,
        progressBehavior: 'Now',
        delay: 0.3,
        data: {
          modelId: 2278,
          motion: 'w-adult-posetilthead01',
          facial: 'face_smile_01',
          facialFirst: true
        }
      },
      // [48]+[49]: Angry line + blushed01 concurrent Motion
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '那是我特意绕去涩谷排了四十分钟队，\n才抢到的季节限定焦糖芝士布丁！',
          emotion: '生气',
          modelId: 2278,
          actions: [{ at: 0, modelId: 2278, motion: 'w-cute-angry01', facial: 'face_angry_01' }]
        }
      },
      {
        type: 'Motion',
        wait: false,
        progressBehavior: 'Now',
        delay: 0.3,
        data: {
          modelId: 2278,
          motion: 'w-normal-blushed01',
          facial: 'face_angry_01',
          facialFirst: true
        }
      },
      // [51]+[52]: Angry line with shakehand + fidget01
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '我撑到现在就指望这口甜的续命，\n结果你居然一口都不剩全吞了？！',
          emotion: '生气',
          modelId: 2278,
          actions: [
            { at: 0, modelId: 2278, motion: 'w-adult-shakehand01', facial: 'face_angry_01' }
          ]
        }
      },
      {
        type: 'Motion',
        wait: false,
        progressBehavior: 'Now',
        delay: 0.3,
        data: {
          modelId: 2278,
          motion: 'w-normal-fidget01',
          facial: 'face_angry_01',
          facialFirst: true
        }
      },
      // [53]: Angry shout with gentle sigh
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '这像话吗？！你赔我布丁！！',
          emotion: '生气',
          modelId: 2278,
          actions: [{ at: 0, modelId: 2278, motion: 'w-normal-sigh01', facial: 'face_angry_01' }]
        }
      },
      // [67]+[68]: Angry line + Akito concurrent shakehand
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '就算没写名字，那种金边包装一看就很贵好吗？！',
          emotion: '生气',
          modelId: 2278,
          actions: [{ at: 0, modelId: 2278, facial: 'face_angry_01' }]
        }
      },
      {
        type: 'Motion',
        wait: false,
        progressBehavior: 'Now',
        delay: 0.3,
        data: { modelId: 2165, motion: 'm-normal01-shakehand', facial: '', facialFirst: true }
      },
      // [69]-[87]: Brief Ena sadness followed by Akito tsundere concession
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '每天下午三点就卖光了，你现在让我上哪再买一份啊……',
          emotion: '伤心',
          modelId: 2278,
          actions: [{ at: 0, modelId: 2278, motion: 'w-cool-posesad01', facial: 'face_sad_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '彰人',
          content: '……啧。',
          emotion: '平静',
          modelId: 2165,
          actions: [{ at: 0, modelId: 2165, facial: 'face_trouble_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '烦死了……真是一点干劲都没了。',
          emotion: '伤心',
          modelId: 2278,
          actions: [{ at: 0, modelId: 2278, facial: 'face_tired_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '彰人',
          content: '明天放学去街上练歌之前，我顺路绕去涩谷帮你排。',
          emotion: '平静',
          modelId: 2165,
          actions: [{ at: 0, modelId: 2165, facial: 'face_serious_01' }]
        }
      },
      {
        type: 'Motion',
        wait: false,
        progressBehavior: 'Now',
        delay: 0.3,
        data: { modelId: 2165, motion: 'm-normal13-sigh', facial: '', facialFirst: true }
      },
      // [105]+[106]: Heading back to room with m-cool08-plan + face_smile_01
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '彰人',
          content: '……行了，那我回房了。',
          emotion: '平静',
          modelId: 2165,
          actions: [{ at: 0, modelId: 2165, facial: 'face_normal_01' }]
        }
      },
      {
        type: 'Motion',
        wait: false,
        progressBehavior: 'Now',
        delay: 0.3,
        data: { modelId: 2165, motion: 'm-cool08-plan', facial: 'face_smile_01', facialFirst: true }
      },
      // [109]+[110]: Akito grumbling + Ena listener armescape01l
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '彰人',
          content: '知道了，烦死了。',
          emotion: '平静',
          modelId: 2165,
          closeWindowOnFinish: true,
          actions: [{ at: 0, modelId: 2165, facial: 'face_trouble_01' }]
        }
      },
      {
        type: 'Motion',
        wait: false,
        progressBehavior: 'Now',
        delay: 0.3,
        data: { modelId: 2278, motion: 'w-normal-armescape01l', facial: '', facialFirst: true }
      },
      {
        type: 'LayoutClear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: 2278, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 } }
      },
      {
        type: 'LayoutClear',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: {
          modelId: 2165,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Right', offset: 0 }
        }
      },
      {
        type: 'BlackOut',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { duration: 600 }
      }
    ]
  }

  // Pre-repair audit MUST catch dual appear collision, waving without greeting context, shy during anger, plan on bedtime
  const preAudit = auditStoryActingAndFidelity(brokenPatchStory, view)
  assert.equal(preAudit.passed, false)
  assert.ok(
    preAudit.diagnostics.some((d) => d.code === 'greeting_motion_without_greeting_context'),
    'audit must flag unmotivated shakehand waving'
  )
  assert.ok(
    preAudit.diagnostics.some((d) => d.code === 'dual_appear_motion_collision'),
    'audit must flag dual simultaneous LayoutAppear waving collision'
  )
  assert.ok(
    preAudit.diagnostics.some((d) => d.code === 'shy_motion_on_angry_line'),
    'audit must flag blushed/fidget during angry lines'
  )
  assert.ok(
    preAudit.diagnostics.some((d) => d.code === 'plan_motion_without_scheming_context'),
    'audit must flag m-cool08-plan on bedtime line'
  )

  // Run validateAndFixStory TWICE (simulating initial compose + post-director-review re-validation!)
  const pass1 = validateAndFixStory(brokenPatchStory, view, undefined, {
    emotionLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  })
  const pass2 = validateAndFixStory(pass1.story, view, undefined, {
    emotionLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  })
  const fixed = pass2.story

  // Zero waving, shy-on-anger, plan, or face_cry_01 leaks anywhere in the repaired story!
  for (const s of fixed.snippets) {
    const d = s.data || {}
    const allMotions = [
      d.motion || '',
      ...(Array.isArray(d.actions) ? d.actions.map((a) => a.motion || '') : [])
    ].filter(Boolean)
    const allFacials = [
      d.facial || '',
      ...(Array.isArray(d.actions) ? d.actions.map((a) => a.facial || '') : [])
    ].filter(Boolean)

    for (const m of allMotions) {
      assert.ok(
        !/shakehand|greeting|blushed|fidget|armescape|plan|posetilthead/i.test(m),
        `repaired story must not contain off-mood motion ${m} in ${s.type}`
      )
    }
    for (const f of allFacials) {
      assert.notEqual(f, 'face_cry_01', `non-crying banter must never receive face_cry_01`)
    }
  }

  // Empty facial on Akito's sigh Motion must remain empty (NOT overwritten to face_smile_01 or face_cry_01 on pass 2!)
  const akitoSighMotion = fixed.snippets.find(
    (s) => s.type === 'Motion' && s.data?.modelId === 2165 && /sigh/i.test(s.data?.motion || '')
  )
  if (akitoSighMotion) {
    assert.equal(
      akitoSighMotion.data.facial,
      '',
      'second validateAndFixStory pass must preserve empty facial on Motion snippet instead of injecting defaultFacial smile'
    )
  }

  // Akito's tsundere lines must stay 平静 (NOT over-promoted to 伤心!)
  const akitoTch = fixed.snippets.find(
    (s) => s.type === 'Talk' && s.data?.content?.includes('……啧')
  )
  assert.equal(akitoTch?.data?.emotion, '平静', 'Akito tsundere 啧 must not be promoted to 伤心')
  const akitoQueue = fixed.snippets.find(
    (s) => s.type === 'Talk' && s.data?.content?.includes('顺路绕去涩谷帮你排')
  )
  assert.equal(
    akitoQueue?.data?.emotion,
    '平静',
    'Akito practical concession line must not be promoted to 伤心'
  )

  const postAudit = auditStoryActingAndFidelity(fixed, view)
  assert.equal(
    postAudit.passed,
    true,
    `repaired story must pass audit cleanly, got: ${JSON.stringify(postAudit.diagnostics)}`
  )
})

test('composer, actingHelpers, direction prompt, and directorReview enforce anti-waving & dual-actor rules', () => {
  const view = makeShinonomeView()

  // pickAppearFallbackMotion never returns greeting/shakehand/blushed/plan
  const appearFallback1 = pickAppearFallbackMotion(view, 2278)
  const appearFallback2 = pickAppearFallbackMotion(view, 2165)
  assert.ok(!/greeting|shakehand|blushed|fidget|plan/i.test(appearFallback1))
  assert.ok(!/greeting|shakehand|blushed|fidget|plan/i.test(appearFallback2))

  // recommendActingForLine for non-crying sad line prefers face_sad/trouble over face_cry
  const recNonCry = recommendActingForLine({
    facials: view.models[1].facials,
    motions: view.models[1].motions,
    modelPath: view.models[1].path,
    content: '真拿你没办法，算我理亏。',
    emotion: '伤心'
  })
  assert.notEqual(
    recNonCry.facials[0],
    'face_cry_01',
    'non-crying sad line must not recommend face_cry_01 first'
  )

  // composeStory with dual LayoutAppear never emits simultaneous waving or identical stems
  const plan = normalizeCastPlan(
    {
      title: '深夜布丁',
      event: '姐弟围绕布丁斗嘴',
      background: 'cloud/bg_e001003',
      cast: [
        { modelId: 2278, name: '绘名', role: '姐姐' },
        { modelId: 2165, name: '彰人', role: '弟弟' }
      ]
    },
    view,
    { scene: '深夜东云家客厅布丁争执', personas: [] }
  )
  const dialogue = normalizeDialogue(
    {
      title: '深夜布丁',
      lines: [
        { id: 'l1', speaker: '绘名', content: '彰人！你是不是吃了我的布丁？！', emotion: '生气' },
        { id: 'l2', speaker: '彰人', content: '上面又没写名字，吵死了。', emotion: '生气' }
      ]
    },
    plan
  )
  const staging = normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'cloud/bg_e001003',
          ambient: 'night',
          bgm: 'cloud/bgm00054.mp3',
          activeCast: [2278, 2165]
        }
      ],
      events: []
    },
    view,
    plan,
    dialogue
  )
  const direction = normalizeDirection(
    {
      background: 'cloud/bg_e001003',
      lines: [
        {
          id: 'l1',
          motion: 'w-adult01-shakehand',
          facial: 'face_angry_01',
          listener: { modelId: 2165, motion: 'm-normal01-shakehand', facial: 'face_angry_01' }
        },
        { id: 'l2', motion: 'm-normal13-angry', facial: 'face_angry_01' }
      ]
    },
    view,
    plan,
    dialogue
  )

  const composed = composeStory(view, plan, dialogue, direction, staging)
  const appears = composed.snippets.filter((s) => s.type === 'LayoutAppear')
  assert.equal(appears.length, 2)
  assert.ok(
    appears.every((a) => !/shakehand|greeting/i.test(a.data?.motion || '')),
    'composer dual LayoutAppear must block unmotivated shakehand'
  )
  const firstTalk = composed.snippets.find((s) => s.type === 'Talk')
  const listenerAct = (firstTalk?.data?.actions ?? []).find((a) => a.modelId === 2165)
  assert.ok(
    !listenerAct?.motion || !/shakehand|greeting/i.test(listenerAct.motion),
    'composer must strip waving motion from listener reaction'
  )

  // Prompts warn explicitly against unmotivated greeting/shakehand & dual big motions, and review shows LayoutAppear motion
  const dirPrompt = buildDirectionPrompt(view, plan, dialogue, {
    scene: '深夜客厅',
    personas: []
  })
  assert.match(dirPrompt.user, /shakehand/)
  assert.match(dirPrompt.user, /双人同场/)

  const reviewPrompt = buildDirectorReviewPrompt(view, plan, composed, {
    scene: '深夜客厅',
    personas: []
  })
  assert.match(reviewPrompt.system, /shakehand/)
  assert.match(reviewPrompt.user, /LayoutAppear\(m=2278/)

  // Standalone enforceOfficialStoryInvariants also cleans dual shakehand + tsundere emotion over-promotion
  const direct = structuredClone(composed)
  const firstClearIdx = direct.snippets.findIndex((s) => s.type === 'LayoutClear')
  direct.snippets.splice(firstClearIdx >= 0 ? firstClearIdx : direct.snippets.length, 0, {
    type: 'Talk',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: {
      speaker: '彰人',
      content: '……啧。',
      emotion: '平静',
      modelId: 2165,
      closeWindowOnFinish: true,
      actions: [{ at: 0, modelId: 2165, facial: 'face_trouble_01' }]
    }
  })
  const promoted = syncTalkEmotionContinuity(direct.snippets, {
    models: direct.models,
    view,
    allowedLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  })
  assert.equal(promoted, 0)
  const lint = enforceOfficialStoryInvariants(direct, view)
  assert.equal(lint.passed, true, `unexpected lint issues: ${lint.issues.join('; ')}`)
})
