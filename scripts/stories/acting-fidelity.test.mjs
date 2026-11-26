import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import {
  annotateFacialName,
  annotateMotionName,
  evaluateActingLineMatch,
  inferDramaticContext,
  inspectModelFacial,
  inspectModelMotion,
  isFacialCompatibleWithLine,
  isMotionCompatibleWithLine,
  isSpecialOrStandingMotion,
  pickMoodMatchedFacial,
  pickMoodMatchedMotion,
  recommendActingForLine
} from '../../out-host/host/ai/facialSemantics.js'
import {
  auditStoryActingAndFidelity,
  enforceOfficialStoryInvariants,
  lintOfficialStory
} from '../../out-host/host/ai/officialLinter.js'
import { characterActingProfile } from '../../out-host/host/ai/personas.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import { recommendScenarioCues } from '../../out-host/host/ai/scenarioCues.js'
import {
  getOfficialActingGuidelines,
  selectUnitFewShotExcerpts
} from '../../out-host/host/ai/corpusExamples.js'

const LOCAL_MODELS_ROOT = 'D:/Users/桌面/mzkbot/MySekaiStoryteller/resources/models'
const hasLocalModels = fs.existsSync(LOCAL_MODELS_ROOT)

function makeActingView() {
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
          'w-normal-sigh01',
          'w-normal-trouble01',
          'w-normal-shy01',
          'w-normal-think01',
          'w-normal-forward01',
          'w-normal-relief01',
          'w-normal-frontclear01'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_smile_05',
          'face_closeeye_01',
          'face_closeeye_02',
          'face_sad_01',
          'face_trouble_01',
          'face_shy_01',
          'face_surprise_01',
          'face_serious_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2,
        name: '朝比奈真冬',
        shortName: '真冬',
        path: '18mafuyu_normal/18mafuyu_normal_3.0_f_t05/18mafuyu_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-tilthead01',
          'w-normal-glad01',
          'w-normal-sad01',
          'w-normal-sigh01',
          'w-normal-think01',
          'w-normal-lookdown01'
        ],
        facials: [
          'face_normal_01',
          'face_smallmouth_01',
          'face_smile_01',
          'face_darknormal_01',
          'face_darksmile_01',
          'face_darksad_01',
          'face_closeeye_01',
          'face_serious_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_rooftop.jpg'],
    imageDetails: [{ file: 'bg_rooftop.jpg', name: '神山高校天台', description: '学校天台' }],
    voices: [],
    bgm: ['bgm00003.mp3'],
    bgmDetails: [{ file: 'bgm00003.mp3', name: '日常', description: '日常背景音乐' }]
  })
}

test('inferDramaticContext classifies plot moods accurately across emotional beats', () => {
  assert.equal(inferDramaticContext({ content: '对不起，刚才都是我的错……' }).mood, 'sad_regret')
  assert.equal(inferDramaticContext({ content: '咦！？这是真的吗？' }).mood, 'surprise')
  assert.equal(
    inferDramaticContext({ content: '别再说这种任性的话了！', emotion: '生气' }).mood,
    'angry_frustration'
  )
  assert.equal(
    inferDramaticContext({ content: '才、才没有特意等你呢！', emotion: '害羞' }).mood,
    'shy_hesitation'
  )
  assert.equal(
    inferDramaticContext({ content: '没关系，别勉强自己，慢慢来就好。' }).mood,
    'gentle_reassure'
  )
  assert.equal(
    inferDramaticContext({ content: '我决定了，这次一定要亲口说清楚。' }).mood,
    'inner_resolve'
  )
  assert.equal(
    inferDramaticContext({ content: '（……如果当时能更坦率一点就好了）' }).mood,
    'thinking_monologue'
  )
  assert.equal(
    inferDramaticContext({ content: '好耶！太棒了～♪', emotion: '开心' }).mood,
    'cheerful_banter'
  )
  assert.equal(
    inferDramaticContext({ content: '别再胡闹了！', emotion: '生气', isListener: true }).mood,
    'sad_regret'
  )
})

test('motion semantic inspection, compatibility checks, and acting recommendations work together', () => {
  assert.equal(inspectModelMotion(undefined, 'w-normal-sigh01').role, 'trouble')
  assert.equal(inspectModelMotion(undefined, 'w-happy-wandahoi01').role, 'glad')
  assert.equal(inspectModelMotion(undefined, 'w-normal-forward01').role, 'forward')
  assert.equal(isSpecialOrStandingMotion('w-normal-frontclear01'), true)
  assert.equal(isSpecialOrStandingMotion('w-normal-default01'), true)
  assert.equal(isSpecialOrStandingMotion('w-normal-tilthead01'), false)
  assert.match(annotateMotionName(undefined, 'w-normal-sigh01'), /叹气|无奈/)

  // 欢快动作不能配在道歉/悲伤台词上
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-glad01',
      emotion: '伤心',
      content: '对不起，我还是搞砸了。'
    }).ok,
    false
  )
  // 静态 default 站姿在强情绪拍会被标记不合适
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-default01',
      emotion: '惊讶',
      content: '怎么会这样……！'
    }).ok,
    false
  )

  const view = makeActingView()
  const mizuki = view.modelById(1)
  const pickedMotion = pickMoodMatchedMotion(mizuki.motions, 'sad_regret', mizuki.path, false)
  assert.ok(['w-normal-sigh01', 'w-normal-trouble01', 'w-normal-think01'].includes(pickedMotion))

  const directRec = recommendActingForLine({
    facials: mizuki.facials,
    motions: mizuki.motions,
    modelPath: mizuki.path,
    content: '（……难道被她看出来了吗）',
    isMonologue: true,
    prevFacial: 'face_smile_01'
  })
  assert.equal(directRec.mood, 'thinking_monologue')
  assert.ok(!directRec.facials.includes('face_smile_01'))

  const rec = view.recommendActingChoices(1, {
    content: '抱歉，我没能早点告诉你……',
    emotion: '伤心',
    prevFacial: 'face_smile_01',
    prevMotion: 'w-normal-nod01'
  })
  assert.equal(rec.mood, 'sad_regret')
  assert.ok(!rec.facials.includes('face_smile_01'))
  assert.ok(!rec.motions.includes('w-normal-glad01'))
  assert.ok(!rec.motions.includes('w-normal-frontclear01'))
  assert.ok(!rec.motions.includes('w-normal-default01'))

  const evalRes = evaluateActingLineMatch({
    facial: 'face_smile_01',
    motion: 'w-normal-glad01',
    facials: mizuki.facials,
    motions: mizuki.motions,
    content: '抱歉，都是我的错……',
    emotion: '伤心',
    consecutiveSameFacialCount: 3
  })
  assert.equal(evalRes.ok, false)
  assert.ok(evalRes.issues.some((i) => i.field === 'facial'))
  assert.ok(evalRes.issues.some((i) => i.field === 'motion'))
  assert.ok(evalRes.issues.some((i) => i.field === 'repetition'))
  assert.ok(evalRes.recommendedFacials.length > 0)
  assert.ok(evalRes.recommendedMotions.length > 0)
})

test(
  'real Live2D motion3 curves accurately distinguish genuine smiles vs wry smiles and dark facials',
  { skip: !hasLocalModels && '本地 models 资源目录不存在' },
  () => {
    const ichikaPath =
      '01ichika_normal/01ichika_normal_3.0_f_t04/01ichika_normal_3.0_f_t04.model3.json'
    const mizukiPath = '20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal_3.0_t04.model3.json'
    const mafuyuPath =
      '18mafuyu_normal/18mafuyu_normal_3.0_f_t05/18mafuyu_normal_3.0_f_t05.model3.json'

    assert.equal(
      inspectModelFacial(ichikaPath, 'face_smile_01', LOCAL_MODELS_ROOT).role,
      'genuine_smile'
    )
    assert.equal(
      inspectModelFacial(mizukiPath, 'face_smile_01', LOCAL_MODELS_ROOT).role,
      'genuine_smile'
    )
    assert.equal(
      inspectModelFacial(mizukiPath, 'face_smile_05', LOCAL_MODELS_ROOT).role,
      'wry_smile'
    )
    assert.equal(
      inspectModelFacial(mizukiPath, 'face_smile_06', LOCAL_MODELS_ROOT).role,
      'wry_smile'
    )
    assert.equal(
      inspectModelFacial(mafuyuPath, 'face_darksmile_01', LOCAL_MODELS_ROOT).role,
      'wry_smile'
    )
    assert.equal(inspectModelFacial(mafuyuPath, 'face_darksad_01', LOCAL_MODELS_ROOT).role, 'sad')

    const mot = inspectModelMotion(ichikaPath, 'w-normal-nod01', LOCAL_MODELS_ROOT)
    assert.equal(mot.role, 'nod')
    assert.equal(mot.fromMotion3, true)
    assert.ok((mot.durationSec ?? 0) > 0.5)
  }
)

test('auditStoryActingAndFidelity detects semantic clashes, zero-motion partners, and passes well-acted scripts', () => {
  const view = makeActingView()

  // 1) 问题剧本：道歉配真笑+欢快动作、同瞬碰撞、真冬0动作、台词夹带括号动作
  const badStory = {
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
          motion: 'w-normal-tilthead01',
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
          motion: 'w-normal-nod01',
          facial: 'face_normal_01',
          moveSpeed: 'Normal'
        }
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: i % 2 === 0 ? '瑞希' : '真冬',
          content:
            i === 0
              ? '（微笑）对不起，我还是搞砸了……'
              : i % 2 === 0
                ? '那个……我先整理一下。'
                : '……没关系。',
          emotion: i === 0 ? '伤心' : '平静',
          modelId: i % 2 === 0 ? 1 : 2,
          ...(i === 5 ? { closeWindowOnFinish: true } : {}),
          actions:
            i === 0
              ? [
                  { at: 0, modelId: 1, motion: 'w-normal-glad01', facial: 'face_smile_01' },
                  { at: 0, modelId: 2, motion: 'w-normal-nod01', facial: 'face_normal_01' }
                ]
              : i % 2 === 0
                ? [{ at: 0, modelId: 1, motion: 'w-normal-nod01', facial: 'face_trouble_01' }]
                : [{ at: 0, modelId: 2, facial: 'face_normal_01' }]
        }
      })),
      {
        type: 'LayoutClear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
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
          moveSpeed: 'Normal'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }

  // Note: make model 2 have 0 Talk/Motion body actions by removing its simultaneous action on line 0
  badStory.snippets[3].data.actions = [
    { at: 0, modelId: 1, motion: 'w-normal-glad01', facial: 'face_smile_01' },
    { at: 0, modelId: 2, motion: 'w-normal-glad01', facial: 'face_smile_01' }
  ]
  const badReport = auditStoryActingAndFidelity(badStory, view)
  assert.equal(badReport.passed, false)
  assert.ok(badReport.facialMismatchCount >= 1)
  assert.ok(badReport.motionMismatchCount >= 1)
  assert.ok(badReport.simultaneousCollisionCount >= 1)
  assert.ok(badReport.stageDirectionLeakCount >= 1)
  assert.ok(badReport.diagnostics.some((d) => d.recommendedFacials.length > 0))

  // 2) 优质贴合剧本：通过审查
  const goodStory = {
    models: badStory.models,
    images: badStory.images,
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
          motion: 'w-normal-tilthead01',
          facial: 'face_trouble_01',
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
          content: '抱歉，昨天那段音轨我还是没能修好……',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, facial: 'face_sad_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '真冬',
          content: '……没关系。先发过来，我再听一遍。',
          emotion: '平静',
          modelId: 2,
          actions: [{ at: 0, modelId: 2, motion: 'w-normal-nod01', facial: 'face_smallmouth_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '（……真冬果然比我还冷静啊）',
          emotion: '平静',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-think01', facial: 'face_closeeye_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '真冬',
          content: '别太熬夜。',
          emotion: '平静',
          modelId: 2,
          actions: [
            { at: 0, modelId: 2, motion: 'w-normal-tilthead01', facial: 'face_closeeye_01' }
          ]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '好啦，这次一定按时睡！',
          emotion: '开心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-relief01', facial: 'face_smile_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '真冬',
          content: '……嗯。',
          emotion: '平静',
          modelId: 2,
          closeWindowOnFinish: true,
          actions: [{ at: 0, modelId: 2, motion: 'w-normal-nod01', facial: 'face_normal_01' }]
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
          moveSpeed: 'Normal'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }
  const goodReport = auditStoryActingAndFidelity(goodStory, view)
  assert.equal(
    goodReport.passed,
    true,
    `unexpected diagnostics: ${JSON.stringify(goodReport.diagnostics)}`
  )
  assert.ok(goodReport.score >= 95)
})

test('prompt, personas, scenarioCues, and corpusExamples helpers return rich official guidance', () => {
  const view = makeActingView()
  const motionList = view.annotatedMotionList()
  assert.match(motionList, /w-normal-sigh01\(叹气\/无奈\)/)
  assert.ok(!motionList.includes('frontclear'))
  assert.ok(annotateFacialName(undefined, 'face_purpose_01').includes('坚定'))
  assert.equal(
    isFacialCompatibleWithLine({ facial: 'face_wink_01', content: '我决定了，绝对不会逃避。' }).ok,
    false
  )

  const mafuyuProfile = characterActingProfile('朝比奈真冬')
  assert.equal(mafuyuProfile.restrained, true)
  const emuProfile = characterActingProfile('凤笑梦')
  assert.equal(emuProfile.restrained, false)
  assert.equal(characterActingProfile('小豆泽心羽 09kohane_normal').temperament, 'gentle')
  assert.equal(characterActingProfile('白石杏 10an_normal').temperament, 'expressive')
  assert.equal(characterActingProfile('镜音连 len_normal').temperament, 'playful')

  const cues = recommendScenarioCues('深夜下雨，瑞希推门走进画室端着热茶回忆过去', {
    isFlashback: true
  })
  assert.equal(cues.ambient, 'night')
  assert.equal(cues.transition, 'flashback')
  assert.ok(cues.effects.includes('rain'))
  assert.ok(cues.effects.includes('memories'))
  assert.ok(cues.seCues.some((s) => s.id === 'se00043_b' || s.id === 'se00005_b'))

  const vsExcerpt = selectUnitFewShotExcerpts(
    [{ name: '初音未来', path: '21miku' }],
    '在无人SEKAI聊作曲'
  )
  assert.match(vsExcerpt, /SEKAI/)
  const guidelines = getOfficialActingGuidelines({ castCount: 2, isSekai: true, isFlashback: true })
  assert.match(guidelines, /FlashbackOut/)
  assert.match(guidelines, /wry_smile/)
})

test('despair, monologue, and tearful regret lines reject surprise/notice/angry facials while genuine shock/anger pass', () => {
  const view = makeActingView()
  const mizuki = view.modelById(1)

  // 绝望/伤心独白禁用 surprise/notice/shock
  for (const facial of ['face_surprise_01', 'face_notice_01', 'face_shock_01']) {
    const res1 = isFacialCompatibleWithLine({
      facial,
      emotion: '伤心',
      content: '（那种因为顾虑才滋生出来的“温柔”……）'
    })
    assert.equal(res1.ok, false, `expected ${facial} to fail on despair monologue`)
    assert.equal(res1.reason, 'surprise_on_sad_or_monologue')

    const res2 = isFacialCompatibleWithLine({
      facial,
      emotion: '伤心',
      content: '我就觉得快要窒息了。我根本受不了那个样子……！'
    })
    assert.equal(res2.ok, false, `expected ${facial} to fail on despair exclamation`)
    assert.equal(res2.reason, 'surprise_on_sad_or_monologue')

    const res3 = isFacialCompatibleWithLine({
      facial,
      emotion: '伤心',
      content: '可我还是……没办法面对这样的现实。'
    })
    assert.equal(res3.ok, false, `expected ${facial} to fail on sad resignation`)
    assert.equal(res3.reason, 'surprise_on_sad_or_monologue')
  }

  // 普通思索独白也禁止误挂 surprise/notice
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_notice_01',
      content: '（……如果当时能更坦率一点就好了）',
      isMonologue: true
    }).ok,
    false
  )

  // 真正吃惊的句子仍允许 surprise/shock
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_surprise_01',
      emotion: '惊讶',
      content: '咦……？为什么是你在道歉啊——'
    }).ok,
    true
  )
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_shock_01',
      content: '（……原来真相是这样？！）',
      isMonologue: true
    }).ok,
    true
  )

  // 含泪自责/懊悔禁止误挂 face_angry_01
  const regretRes = isFacialCompatibleWithLine({
    facial: 'face_angry_01',
    emotion: '伤心',
    content: '为什么我什么都没能说出口啊……！！'
  })
  assert.equal(regretRes.ok, false)
  assert.equal(regretRes.reason, 'angry_on_sad_or_regret')

  // 明确生气台词仍允许 face_angry_01
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_angry_01',
      emotion: '生气',
      content: '那你干嘛要跑啊！'
    }).ok,
    true
  )

  // pickMoodMatchedFacial 支持 DramaticContextMood 且绝不回退到 surprise/angry
  const pickedSad = pickMoodMatchedFacial(
    ['face_surprise_01', 'face_angry_01', 'face_sad_01', 'face_trouble_01'],
    'sad_regret'
  )
  assert.equal(pickedSad, 'face_sad_01')

  const evalDespair = evaluateActingLineMatch({
    facial: 'face_notice_01',
    facials: mizuki.facials,
    motions: mizuki.motions,
    content: '我就觉得快要窒息了。我根本受不了那个样子……！',
    emotion: '伤心'
  })
  assert.equal(evalDespair.ok, false)
  assert.ok(evalDespair.issues.some((i) => i.code === 'surprise_on_sad_or_monologue'))
  assert.ok(!evalDespair.recommendedFacials.includes('face_surprise_01'))
})

test('auditStoryActingAndFidelity catches listener_frozen, Move/LayoutAppear mood clashes, duplicate ChangeBgm, and zero-width leaks', () => {
  const view = makeActingView()
  const story = {
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
          motion: 'w-normal-tilthead01',
          facial: 'face_sad_01',
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
          motion: 'w-normal-nod01',
          facial: 'face_surprise_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: 'cloud/bgm00039.mp3', stop: false }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '可我还是……\u200b没办法面对这样的现实。',
          ttsText: '🥺でもボクはやっぱり……向き合えないんだ。',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-sigh01', facial: 'face_sad_01' }]
        }
      },
      {
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: 'cloud/bgm00039.mp3', stop: false }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '我就觉得快要窒息了。我根本受不了那个样子……！',
          ttsText: '😭息が詰まりそうになるんだよ……！',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-trouble01', facial: 'face_trouble_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '每次被那样小心翼翼地对待，我就什么都说不出来了。',
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
          content: '……真的对不起。',
          emotion: '伤心',
          modelId: 1,
          closeWindowOnFinish: true,
          actions: [{ at: 0, modelId: 1, facial: 'face_closeeye_01' }]
        }
      },
      {
        type: 'Move',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 40 },
          motion: '',
          facial: 'face_surprise_01',
          moveSpeed: 'Normal'
        }
      }
    ]
  }

  const report = auditStoryActingAndFidelity(story, view)
  assert.equal(report.passed, false)
  assert.ok(report.listenerFrozenCount >= 1)
  const frozen = report.diagnostics.find((d) => d.code === 'listener_frozen')
  assert.ok(frozen)
  assert.equal(frozen.listenerModelId, 2)
  assert.equal(frozen.snippetIndex, 8)
  assert.match(frozen.message, /at:\s*0/)
  assert.ok(!frozen.message.includes('0.5..0.85'))
  assert.ok(frozen.recommendedFacials.length > 0)
  assert.ok(frozen.recommendedMotions.length > 0)

  assert.equal(report.duplicateBgmCount, 1)
  assert.equal(report.officialReport.metrics.duplicateBgmCount, 1)
  assert.equal(report.zeroWidthCharCount, 1)
  // LayoutAppear (idx 2) and Move (idx 9) both had face_surprise_01 in sad context
  assert.ok(report.diagnostics.some((d) => d.snippetIndex === 2 && d.field === 'facial'))
  assert.ok(report.diagnostics.some((d) => d.snippetIndex === 9 && d.field === 'facial'))

  // Adding a mid-line staggered body motion (at: 0.65) is flagged as staggered_midline_motion
  story.snippets[8].data.actions.push({
    at: 0.65,
    modelId: 2,
    motion: 'w-normal-sad01',
    facial: 'face_darksad_01'
  })
  const afterStagger = auditStoryActingAndFidelity(story, view)
  assert.equal(afterStagger.staggeredMidlineMotionCount, 1)
  assert.ok(afterStagger.diagnostics.some((d) => d.code === 'staggered_midline_motion'))

  // Replacing with official PJSK at: 0 facial-only listener reaction clears both without collision
  story.snippets[8].data.actions[story.snippets[8].data.actions.length - 1] = {
    at: 0,
    modelId: 2,
    facial: 'face_darksad_01'
  }
  const afterOfficialFacial = auditStoryActingAndFidelity(story, view)
  assert.equal(afterOfficialFacial.listenerFrozenCount, 0)
  assert.equal(afterOfficialFacial.staggeredMidlineMotionCount, 0)
  assert.equal(afterOfficialFacial.simultaneousCollisionCount, 0)

  // enforceOfficialStoryInvariants removes duplicate ChangeBgm & strips \u200b while keeping Irodori emojis
  const warnings = []
  enforceOfficialStoryInvariants(story, view, (m) => warnings.push(m))
  assert.equal(lintOfficialStory(story, view).metrics.duplicateBgmCount, 0)
  assert.equal(story.snippets.filter((s) => s.type === 'ChangeBgm').length, 1)
  const talkWithZwc = story.snippets.find((s) => s.type === 'Talk')
  assert.equal(talkWithZwc.data.content.includes('\u200b'), false)
  assert.ok(talkWithZwc.data.ttsText.includes('🥺'), 'Irodori emoji in ttsText must be preserved')
})

const CHOF3Y_PATH =
  'D:/Users/桌面/mzkbot/MySekaiStoryteller/apifile/script-1795627702100-chof3y.json'
test(
  'regression: auditStoryActingAndFidelity catches all real bugs in apifile/script-1795627702100-chof3y.json',
  { skip: !fs.existsSync(CHOF3Y_PATH) && 'chof3y regression fixture not present' },
  () => {
    const story = JSON.parse(fs.readFileSync(CHOF3Y_PATH, 'utf8'))
    const report = auditStoryActingAndFidelity(story)
    assert.equal(report.passed, false)

    // 1. Expression mismatches: despair surprise/notice, Move surprise, LayoutAppear shock, tearful regret angry
    const facialByIdx = new Map(
      report.diagnostics.filter((d) => d.field === 'facial').map((d) => [d.snippetIndex, d])
    )
    assert.equal(facialByIdx.get(39)?.code, 'surprise_on_sad_or_monologue')
    assert.equal(facialByIdx.get(44)?.code, 'surprise_on_sad_or_monologue')
    assert.equal(facialByIdx.get(45)?.code, 'surprise_on_sad_or_monologue')
    assert.equal(facialByIdx.get(46)?.code, 'surprise_on_sad_or_monologue')
    assert.equal(facialByIdx.get(47)?.code, 'surprise_on_sad_or_monologue')
    assert.equal(facialByIdx.get(48)?.code, 'surprise_on_sad_or_monologue')
    assert.equal(facialByIdx.get(55)?.code, 'surprise_on_sad_or_monologue')
    assert.equal(facialByIdx.get(63)?.code, 'angry_on_sad_or_regret')

    // 2. Listener frozen across long consecutive speaker stretches (>=4 spoken lines)
    assert.ok(
      report.listenerFrozenCount >= 1,
      `expected >=1 listener_frozen, got ${report.listenerFrozenCount}`
    )

    // 3. Duplicate consecutive ChangeBgm (snippet 24) & missing SE warning
    assert.equal(report.duplicateBgmCount, 1)
    assert.ok(report.diagnostics.some((d) => d.code === 'duplicate_bgm' && d.snippetIndex === 24))
    assert.ok(report.officialReport.warnings.some((w) => w.includes('Sound/PlaySe')))

    // 4. Zero-width chars in content (snippets 42 & 43), while Irodori emojis in ttsText are NOT flagged
    assert.equal(report.zeroWidthCharCount, 2)
    assert.ok(
      report.diagnostics.some((d) => d.code === 'content_zero_width_leak' && d.snippetIndex === 42)
    )
    assert.ok(
      report.diagnostics.some((d) => d.code === 'content_zero_width_leak' && d.snippetIndex === 43)
    )
    assert.equal(
      report.diagnostics.some((d) => d.code.includes('emoji')),
      false,
      'must not flag Irodori emojis in ttsText'
    )
  }
)

test('official PJSK parity: listener mood inference, strict motion compatibility, style consistency, and relaxed motion hold', () => {
  // Listener mood: monologue -> attentive_listen, speaker sad -> sad_regret (NOT gentle_reassure), speaker surprise -> attentive_listen
  assert.equal(
    inferDramaticContext({
      content: '（……刚才那一瞬间，我明明也僵在原地了。）',
      emotion: '伤心',
      isListener: true
    }).mood,
    'attentive_listen'
  )
  assert.equal(
    inferDramaticContext({
      content: '我真的不是你想的那样……',
      emotion: '伤心',
      isListener: true
    }).mood,
    'sad_regret'
  )
  assert.equal(
    inferDramaticContext({
      content: '为什么不行……？',
      emotion: '惊讶',
      prevEmotion: '伤心',
      isListener: true
    }).mood,
    'sad_regret'
  )

  // Sad/despair lines reject tilthead, greeting, relief, surprise, angry motions
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-tilthead01',
      emotion: '伤心',
      content: '……不行啊，绘名。',
      isListener: true
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-greeting01',
      emotion: '伤心',
      content: '对不起，我还是没能说出口。'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-surprise01',
      emotion: '伤心',
      content: '我就觉得快要窒息了。'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-angry01',
      emotion: '伤心',
      content: '为什么我什么都没能说出口啊……'
    }).ok,
    false
  )

  // Style consistency: w-normal-* preferred over w-cool-*
  const picked = pickMoodMatchedMotion(
    ['w-cool-posesad01', 'w-normal-sad01', 'w-normal-sigh01'],
    'sad_regret'
  )
  assert.equal(picked, 'w-normal-sad01')

  // Consecutive same motion is allowed up to 3 lines, flagged at >=4
  const holdOk = evaluateActingLineMatch({
    motion: 'w-normal-sad01',
    facial: 'face_sad_01',
    facials: ['face_sad_01', 'face_trouble_01'],
    motions: ['w-normal-sad01', 'w-normal-sigh01'],
    content: '……因为大家，都太温柔了。',
    emotion: '伤心',
    consecutiveSameMotionCount: 2
  })
  assert.equal(
    holdOk.issues.some((i) => i.code === 'consecutive_same_motion'),
    false
  )
  const holdFlag = evaluateActingLineMatch({
    motion: 'w-normal-sad01',
    facial: 'face_sad_01',
    facials: ['face_sad_01', 'face_trouble_01'],
    motions: ['w-normal-sad01', 'w-normal-sigh01'],
    content: '……因为大家，都太温柔了。',
    emotion: '伤心',
    consecutiveSameMotionCount: 4
  })
  assert.equal(
    holdFlag.issues.some((i) => i.code === 'consecutive_same_motion'),
    true
  )
})

const EVENT_145_08_PATH =
  'D:/Users/桌面/mzkbot/MySekaiStoryteller/resources/stories/event_145_08.sekai-story.json'
const XWW9BI_PATH =
  'D:/Users/桌面/mzkbot/MySekaiStoryteller/apifile/script-1795634483120-xww9bi.json'
test(
  'regression: event_145_08 matches official in-place fade & at=0 baseline while xww9bi.json bugs are caught',
  {
    skip:
      (!fs.existsSync(EVENT_145_08_PATH) || !fs.existsSync(XWW9BI_PATH)) &&
      'event_145_08 or xww9bi fixture not present'
  },
  () => {
    const official = JSON.parse(fs.readFileSync(EVENT_145_08_PATH, 'utf8'))
    const officialLint = lintOfficialStory(official)
    assert.equal(officialLint.metrics.inPlaceAppearShare, 1)
    assert.equal(officialLint.metrics.inPlaceClearShare, 1)
    assert.equal(officialLint.metrics.slideEntryExitCount, 0)
    assert.equal(officialLint.metrics.staggeredListenerActionCount, 0)
    assert.equal(officialLint.metrics.staggeredListenerMotionCount, 0)

    const xww9bi = JSON.parse(fs.readFileSync(XWW9BI_PATH, 'utf8'))
    const xwwReport = auditStoryActingAndFidelity(xww9bi)
    assert.equal(xwwReport.passed, false)
    assert.equal(xwwReport.staggeredMidlineMotionCount, 8)
    assert.equal(xwwReport.officialReport.metrics.staggeredListenerActionCount, 37)
    assert.equal(xwwReport.officialReport.metrics.slideEntryExitCount, 2)
    assert.ok(xwwReport.diagnostics.some((d) => d.code === 'excessive_staggered_listener'))
    assert.ok(xwwReport.diagnostics.some((d) => d.code === 'staggered_midline_motion'))
    assert.ok(xwwReport.diagnostics.some((d) => d.code === 'excessive_slide_entry_exit'))
    assert.ok(
      xwwReport.diagnostics.some(
        (d) => d.snippetIndex === 29 && d.code === 'tilthead_motion_on_sad_line'
      ),
      'must catch Mizuki tilthead clash on snippet #29'
    )
  }
)

test('recency-weighted non-rigid acting: emotional facial hold up to 4 lines, soft relief/questioning tilthead allowed, diverse curated variants', () => {
  // 1) Sustained sad facial hold (4 consecutive lines) is natural per 61.7% official corpus hold rate; >=5 gently flagged
  const hold4 = evaluateActingLineMatch({
    facial: 'face_sad_01',
    motion: 'w-normal-sigh01',
    facials: ['face_sad_01', 'face_trouble_01', 'face_closeeye_01'],
    motions: ['w-normal-sigh01', 'w-normal-trouble01'],
    content: '……真的对不起，我还是没办法面对。',
    emotion: '伤心',
    consecutiveSameFacialCount: 4
  })
  assert.equal(
    hold4.issues.some((i) => i.code === 'consecutive_same_facial'),
    false,
    'holding sad facial for 4 lines must not be rigidly flagged'
  )
  const hold5 = evaluateActingLineMatch({
    facial: 'face_sad_01',
    motion: 'w-normal-sigh01',
    facials: ['face_sad_01', 'face_trouble_01', 'face_closeeye_01'],
    motions: ['w-normal-sigh01', 'w-normal-trouble01'],
    content: '……真的对不起，我还是没办法面对。',
    emotion: '伤心',
    consecutiveSameFacialCount: 5
  })
  assert.equal(
    hold5.issues.some((i) => i.code === 'consecutive_same_facial'),
    true,
    'holding same facial for >=5 lines still surfaces a gentle reminder'
  )

  // 2) Non-despair resigned sad line allows w-normal-relief01 & questioning speaker allows tilthead, while despair still blocks
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-relief01',
      emotion: '伤心',
      content: '……嗯，能把这些说出来，稍微好受一点了。'
    }).ok,
    true
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-relief01',
      emotion: '伤心',
      content: '我就觉得快要窒息了……！'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-tilthead01',
      emotion: '伤心',
      content: '……为什么会变成这样呢？'
    }).ok,
    true
  )

  // 3) Curated promptMotions/promptFacials include multiple emotional variants + cross-style fallback while staying compact
  const richView = new CatalogView({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: [
          'w-normal-sad01',
          'w-adult-sad02',
          'w-normal-trouble01',
          'w-cool-trouble02',
          'w-normal-sigh01',
          'w-normal-sigh02',
          'w-normal-nod01',
          'w-normal-default01'
        ],
        facials: [
          'face_normal_01',
          'face_sad_01',
          'face_sad_02',
          'face_cry_01',
          'face_cry_02',
          'face_closeeye_01',
          'face_closeeye_02'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: [],
    imageDetails: [],
    voices: [],
    bgm: [],
    bgmDetails: []
  })
  const m = richView.modelById(1)
  const motions = richView.promptMotions(m)
  const facials = richView.promptFacials(m)
  assert.ok(motions.includes('w-normal-sad01') && motions.includes('w-adult-sad02'))
  assert.ok(motions.includes('w-normal-trouble01') && motions.includes('w-cool-trouble02'))
  assert.ok(facials.includes('face_cry_01') && facials.includes('face_cry_02'))
  assert.ok(facials.includes('face_sad_01') && facials.includes('face_sad_02'))
})
