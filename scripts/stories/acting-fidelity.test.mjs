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
  applyDirectorReviewPatches,
  composeStory,
  normalizeDirection,
  normalizeStaging
} from '../../out-host/host/ai/staged.js'
import { validateAndFixStory } from '../../out-host/host/ai/validate.js'
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
  // 1) Sustained sad/cry facial hold (4..8 consecutive lines) is natural during emotional climax; >=9 gently flagged; trouble >=5 flagged
  const hold8 = evaluateActingLineMatch({
    facial: 'face_sad_01',
    motion: 'w-normal-sigh01',
    facials: ['face_sad_01', 'face_trouble_01', 'face_closeeye_01'],
    motions: ['w-normal-sigh01', 'w-normal-trouble01'],
    content: '……真的对不起，我还是没办法面对。',
    emotion: '伤心',
    consecutiveSameFacialCount: 8
  })
  assert.equal(
    hold8.issues.some((i) => i.code === 'consecutive_same_facial'),
    false,
    'holding sad/cry facial up to 8 lines must not be rigidly flagged'
  )
  const hold9 = evaluateActingLineMatch({
    facial: 'face_sad_01',
    motion: 'w-normal-sigh01',
    facials: ['face_sad_01', 'face_trouble_01', 'face_closeeye_01'],
    motions: ['w-normal-sigh01', 'w-normal-trouble01'],
    content: '……真的对不起，我还是没办法面对。',
    emotion: '伤心',
    consecutiveSameFacialCount: 9
  })
  assert.equal(
    hold9.issues.some((i) => i.code === 'consecutive_same_facial'),
    true,
    'holding sad/cry facial for >=9 lines still surfaces a gentle reminder'
  )
  const trouble5 = evaluateActingLineMatch({
    facial: 'face_trouble_01',
    motion: 'w-normal-sigh01',
    facials: ['face_sad_01', 'face_trouble_01', 'face_closeeye_01'],
    motions: ['w-normal-sigh01', 'w-normal-trouble01'],
    content: '……这下可有点难办了呢。',
    emotion: '困扰',
    consecutiveSameFacialCount: 5
  })
  assert.equal(
    trouble5.issues.some((i) => i.code === 'consecutive_same_facial'),
    true,
    'holding trouble facial for >=5 lines still surfaces a gentle reminder'
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

test('v4 fix #1: face_trouble_02 (ParamMouthForm >= 0.2) is wry_smile and blocked on sad/crying lines', (t) => {
  if (!hasLocalModels) {
    t.skip('local model motion3.json directory unavailable')
    return
  }
  const enaPath = 'cloud/v2_19ena_casual/19ena_clathes2_4_t06/19ena_clathes2_4_t06.model3.json'
  const info = inspectModelFacial(enaPath, 'face_trouble_02')
  assert.equal(info.role, 'wry_smile')
  assert.ok((info.mouthForm ?? 0) >= 0.2, `expected mouthForm >= 0.2, got ${info.mouthForm}`)
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_trouble_02',
      modelPath: enaPath,
      emotion: '伤心',
      content: '嗯……？'
    }).ok,
    false,
    'face_trouble_02 grin must be blocked on sad confrontation lines'
  )
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_trouble_02',
      modelPath: enaPath,
      emotion: '伤心',
      content: '不行啊……！'
    }).ok,
    false
  )
  assert.equal(
    isFacialCompatibleWithLine({
      facial: 'face_trouble_02',
      modelPath: enaPath,
      emotion: '平静',
      content: '没关系，我笑着面对就好。'
    }).ok,
    true,
    'explicit wry/reassuring smile line should still allow wry_smile'
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-glad01',
      emotion: '伤心',
      content: '我好害怕……'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-greeting01',
      emotion: '伤心',
      content: '对不起……',
      prevTense: true
    }).ok,
    false
  )
})

test('v4 fix #2/#3/#4/#5: sustained crying, real-motion safety, no slides, and clean closeWindowOnFinish', () => {
  const mizukiNoNormalSadView = new CatalogView({
    models: [
      {
        id: 2294,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: 'v2_20mizuki_uniform/20mizuki_uniform2_4_t11/20mizuki_uniform2_4_t11.model3.json',
        motions: [
          'w-normal07-sad',
          'w-normal08-sad',
          'w-adult02-trouble',
          'w-normal-nod01',
          'w-normal-glad01',
          'w-normal-default01'
        ],
        facials: ['face_normal_01', 'face_cry_01', 'face_cry_02', 'face_sad_01', 'face_closeeye_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 2295,
        name: '东云绘名',
        shortName: '绘名',
        path: 'v2_19ena_casual/19ena_clathes2_4_t06/19ena_clathes2_4_t06.model3.json',
        motions: ['w-normal-sad01', 'w-normal-trouble01', 'w-normal-sigh01', 'w-normal-default01'],
        facials: ['face_normal_01', 'face_sad_01', 'face_cry_01', 'face_serious_01', 'face_closeeye_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_rooftop.jpg'],
    imageDetails: [],
    voices: [],
    bgm: ['bgm00028.mp3'],
    bgmDetails: []
  })

  const plan = {
    title: '暴雨与泪水',
    event: '两人在屋顶泪流不止地摊牌',
    background: 'bg_rooftop.jpg',
    bgm: 'bgm00028.mp3',
    cast: [
      {
        modelId: 2294,
        name: '瑞希',
        fullName: '晓山瑞希',
        path: 'v2_20mizuki_uniform/20mizuki_uniform2_4_t11/20mizuki_uniform2_4_t11.model3.json',
        role: '哭着崩溃'
      },
      {
        modelId: 2295,
        name: '绘名',
        fullName: '东云绘名',
        path: 'v2_19ena_casual/19ena_clathes2_4_t06/19ena_clathes2_4_t06.model3.json',
        role: '认真回应'
      }
    ]
  }
  const dialogue = {
    lines: [
      { id: 'l1', speaker: '瑞希', emotion: '伤心', content: '对不起……一直都瞒着你……' },
      { id: 'l2', speaker: '瑞希', emotion: '伤心', content: '可是我真的好害怕……' },
      { id: 'l3', speaker: '瑞希', emotion: '伤心', content: '我不敢让你看到这样的自己！' },
      { id: 'l4', speaker: '瑞希', emotion: '伤心', content: '真的好痛苦……！' },
      { id: 'l5', speaker: '绘名', emotion: '伤心', content: '瑞希……我怎么可能会讨厌你。' },
      { id: 'l6', speaker: '瑞希', emotion: '伤心', content: '（……难道真的还能像以前那样吗？）' },
      { id: 'l7', speaker: '绘名', emotion: '伤心', content: '不要一个人哭着扛啊。' }
    ]
  }
  const direction = normalizeDirection(
    {
      lines: [
        { lineId: 'l1', motion: 'w-normal-sad01', facial: 'face_cry_01' },
        { lineId: 'l2', motion: 'w-normal-glad01', facial: 'face_cry_01' },
        { lineId: 'l3', motion: 'w-normal07-sad', facial: 'face_cry_01' },
        { lineId: 'l4', motion: 'w-normal08-sad', facial: 'face_cry_01' },
        { lineId: 'l5', motion: 'w-normal-sad01', facial: 'face_sad_01' },
        { lineId: 'l6', motion: 'w-adult02-trouble', facial: 'face_cry_01' },
        { lineId: 'l7', motion: 'w-normal-sigh01', facial: 'face_sad_01' }
      ]
    },
    mizukiNoNormalSadView,
    plan,
    dialogue
  )
  const staging = normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_rooftop.jpg',
          activeCast: ['瑞希', '绘名'],
          walkInCast: ['瑞希']
        }
      ],
      events: [
        {
          lineId: 'l3',
          move: { modelId: 2294, kind: 'stepCloser', offset: 90 }
        },
        {
          lineId: 'l6',
          stageGroup: { activeCast: ['瑞希'] }
        },
        {
          lineId: 'l7',
          stageGroup: { activeCast: ['瑞希', '绘名'] }
        }
      ]
    },
    mizukiNoNormalSadView,
    plan,
    dialogue
  )

  const composed = composeStory(mizukiNoNormalSadView, plan, dialogue, direction, staging)
  const { story: fixed } = validateAndFixStory(composed, mizukiNoNormalSadView)

  // #4: Zero slides (no Move snippets, no LeftOver/RightOver/offset!=0 on LayoutAppear/LayoutClear)
  assert.equal(
    fixed.snippets.filter((s) => s.type === 'Move').length,
    0,
    'must never emit Move slide snippets'
  )
  for (const s of fixed.snippets) {
    if (s.type === 'LayoutAppear' || s.type === 'LayoutClear') {
      assert.equal(s.data.from.side, s.data.to.side, `${s.type} must stay in-place`)
      assert.equal(s.data.from.offset ?? 0, 0)
      assert.equal(s.data.to.offset ?? 0, 0)
    }
  }

  // #2 & #3: Sustained crying held (no face_closeeye spam, no w-normal-sad01 on model 2294, no w-normal-glad01)
  const mizukiTalks = fixed.snippets.filter((s) => s.type === 'Talk' && s.data.modelId === 2294)
  const mizukiCryCount = mizukiTalks.filter((s) =>
    (s.data.actions ?? []).some((a) => a.modelId === 2294 && a.facial === 'face_cry_01')
  ).length
  assert.ok(mizukiCryCount >= 4, `expected >= 4 sustained face_cry_01 lines, got ${mizukiCryCount}`)
  for (const s of fixed.snippets) {
    if (s.type === 'Talk') {
      for (const a of s.data.actions ?? []) {
        if (a.modelId === 2294 && a.motion) {
          assert.notEqual(a.motion, 'w-normal-sad01', 'must never emit nonexistent w-normal-sad01 onto 2294')
          assert.notEqual(a.motion, 'w-normal-glad01', 'must never emit happy motion in sad scene')
        }
      }
    }
  }

  // #5: No closeWindowOnFinish followed by instantaneous snippets directly into another Talk without a real break/transition
  const realBreakTypes = new Set([
    'LayoutClear',
    'LayoutAppear',
    'BlackOut',
    'WhiteOut',
    'SideFade',
    'Telop',
    'FullScreenText',
    'HideTalk'
  ])
  for (let i = 0; i < fixed.snippets.length - 1; i++) {
    const s = fixed.snippets[i]
    if (s.type === 'Talk' && s.data.closeWindowOnFinish) {
      let sawBreak = false
      for (let j = i + 1; j < fixed.snippets.length; j++) {
        const nxt = fixed.snippets[j]
        if (realBreakTypes.has(nxt.type) || (nxt.type === 'Wait' && Number(nxt.data?.duration ?? 0) >= 300)) {
          sawBreak = true
          break
        }
        if (nxt.type === 'Talk') break
      }
      if (!sawBreak) {
        assert.fail(`unexpected closeWindowOnFinish with no real break/transition before next Talk at #${i}`)
      }
    }
  }

  // Also test enforceOfficialStoryInvariants strips spurious closeWindowOnFinish before Motion -> Talk
  const polluted = structuredClone(fixed)
  const firstTalkIdx = polluted.snippets.findIndex((s) => s.type === 'Talk')
  polluted.snippets[firstTalkIdx].data.closeWindowOnFinish = true
  polluted.snippets.splice(firstTalkIdx + 1, 0, {
    type: 'Motion',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0.25,
    data: { modelId: 2295, motion: 'w-normal-sigh01', facial: '', facialFirst: true }
  })
  enforceOfficialStoryInvariants(polluted, mizukiNoNormalSadView, () => {})
  const fixedFirstTalk = polluted.snippets[firstTalkIdx]
  assert.notEqual(
    fixedFirstTalk.data.closeWindowOnFinish,
    true,
    'enforceOfficialStoryInvariants must strip closeWindowOnFinish before instantaneous Motion -> Talk'
  )

  // Irodori ZWJ / \uFE0F emoji preservation in ttsText through applyDirectorReviewPatches (no content edit)
  const irodoriTts = 'ごめんね……\u200D♀️本当は怖かったんだ。️'
  polluted.snippets[firstTalkIdx].data.ttsText = irodoriTts
  const patched = applyDirectorReviewPatches(polluted, {
    dramaticArc: 'ok',
    emotionalContinuityAndVoice: 'ok',
    audioAndSeDesign: 'ok',
    stageRhythm: 'ok',
    actingNaturalness: 'ok',
    concreteFixes: ['polish acting'],
    operations: [{ op: 'update_acting', index: firstTalkIdx, facial: 'face_cry_01' }]
  })
  assert.equal(patched.story.snippets[firstTalkIdx].data.ttsText, irodoriTts)
})

test('v6 acting hygiene: context-bound motions, tense listener forced-smile guard, deflection restraint, and trailing short Motion removal', () => {
  // 1) Context-bound motion classification & compatibility (food / sleep / sing)
  const delInfo = inspectModelMotion(undefined, 'w-adult-delicious01')
  assert.equal(delInfo.contextTag, 'food')
  assert.notEqual(delInfo.role, 'glad')
  assert.notEqual(delInfo.role, 'playful')
  assert.equal(inspectModelMotion(undefined, 'w-cute11-deliciousB').contextTag, 'food')
  assert.equal(inspectModelMotion(undefined, 'w-adult15-sleepB').contextTag, 'sleep')
  assert.equal(inspectModelMotion(undefined, 'w-normal-yawn01').contextTag, 'sleep')
  assert.equal(inspectModelMotion(undefined, 'w-normal-sing01').contextTag, 'sing')
  assert.equal(inspectModelMotion(undefined, 'w-cute-mic01').contextTag, 'sing')

  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-adult-delicious01',
      emotion: '开心',
      content: '天台的风好大哦，头发都要吹乱啦♪晚上的庆祝会快开始了，我们下去吧？'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-adult-delicious01',
      emotion: '开心',
      content: '这家店的草莓松饼好好吃哦～♪'
    }).ok,
    true
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-adult15-sleepB',
      emotion: '平静',
      content: '走吧，我们去天台。'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-adult15-sleepB',
      emotion: '平静',
      content: '好困啊……昨天熬夜画稿没睡好。'
    }).ok,
    true
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-sing01',
      emotion: '开心',
      content: '今天天气真不错！'
    }).ok,
    false
  )
  assert.equal(
    isMotionCompatibleWithLine({
      motion: 'w-normal-sing01',
      emotion: '开心',
      content: '大家一起在舞台上练习唱歌吧！'
    }).ok,
    true
  )

  // pickMoodMatchedMotion must never fall back to food/sleep/sing motions for generic cheerful beats
  assert.equal(
    pickMoodMatchedMotion(['w-adult-delicious01', 'w-normal-nod01'], 'cheerful_banter'),
    'w-normal-nod01'
  )

  // 2) Listener forced-smile leak & tense confrontation deflection + 3) trailing <400ms Motion removal
  const v6View = new CatalogView({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-trouble01',
          'w-normal-sad01',
          'w-cool-sad01',
          'w-normal-glad02',
          'w-adult-delicious01'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_smile_05',
          'face_closeeye_01',
          'face_closeeye_02',
          'face_trouble_01',
          'face_sad_01',
          'face_serious_01',
          'face_smug_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 2,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal_3.0_f_t06/19ena_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-angry01',
          'w-normal-trouble01',
          'w-normal-sad01',
          'w-normal-glad01'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_angry_01',
          'face_serious_01',
          'face_trouble_01',
          'face_sad_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_rooftop.jpg'],
    imageDetails: [{ file: 'bg_rooftop.jpg', name: '神山高校·天台', description: '学校天台' }],
    voices: [],
    bgm: ['bgm00297.mp3'],
    bgmDetails: [{ file: 'bgm00297.mp3', name: '对峙', description: '紧张对峙' }]
  })

  const badConfrontation = {
    models: [
      { id: 1, model: v6View.models[0].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 2, model: v6View.models[1].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_rooftop.jpg' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, progressBehavior: 'Now', delay: 0, data: { mode: 'Normal' } },
      { type: 'ChangeBackgroundImage', wait: false, progressBehavior: 'Now', delay: 0, data: { imageId: 1 } },
      {
        type: 'LayoutAppear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: 1, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 }, motion: 'w-normal-trouble01', facial: 'face_trouble_01' }
      },
      {
        type: 'LayoutAppear',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: 2, from: { side: 'Right', offset: 0 }, to: { side: 'Right', offset: 0 }, motion: 'w-normal-angry01', facial: 'face_serious_01' }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '哈啊……哈啊……瑞希！',
          emotion: '生气',
          modelId: 2,
          actions: [{ at: 0, modelId: 2, motion: 'w-normal-nod01', facial: 'face_serious_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '啊……绘、绘名？怎么跑得这么急呀，差点被你吓一跳呢～',
          emotion: '开心',
          modelId: 1,
          actions: [
            { at: 0, modelId: 1, motion: 'w-normal-glad02', facial: 'face_smile_01' },
            { at: 0, modelId: 2, facial: 'face_smile_01' }
          ]
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '天台的风好大哦，头发都要吹乱啦♪晚上的庆祝会快开始了，我们下去吧？',
          emotion: '开心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-adult-delicious01', facial: 'face_closeeye_02' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '绘名',
          content: '别开玩笑了！',
          emotion: '生气',
          modelId: 2,
          closeWindowOnFinish: true,
          actions: [{ at: 0, modelId: 2, motion: 'w-normal-angry01', facial: 'face_angry_01' }]
        }
      },
      {
        type: 'Motion',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0.25,
        data: { modelId: 1, motion: 'w-cool-sad01', facial: 'face_sad_01', facialFirst: true }
      },
      {
        type: 'LayoutClear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: 1, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 } }
      },
      {
        type: 'LayoutClear',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: 2, from: { side: 'Right', offset: 0 }, to: { side: 'Right', offset: 0 } }
      },
      { type: 'BlackOut', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { duration: 600 } }
    ]
  }

  const preAudit = auditStoryActingAndFidelity(badConfrontation, v6View)
  assert.equal(preAudit.passed, false)
  assert.ok(preAudit.diagnostics.some((d) => d.code === 'listener_forced_smile'))
  assert.ok(preAudit.diagnostics.some((d) => d.code === 'glad_motion_on_tense_deflection'))
  assert.ok(preAudit.diagnostics.some((d) => d.code === 'food_motion_without_food_context'))
  assert.ok(preAudit.officialReport.issues.some((iss) => iss.includes('孤立短 Motion')))

  // Direct enforceOfficialStoryInvariants repairs all 3 issues standalone
  const directCopy = structuredClone(badConfrontation)
  const postLint = enforceOfficialStoryInvariants(directCopy, v6View, () => {})
  assert.equal(postLint.passed, true, `unexpected lint issues: ${postLint.issues.join('; ')}`)
  assert.equal(
    directCopy.snippets.some((s) => s.type === 'Motion' && s.data?.motion === 'w-cool-sad01'),
    false,
    'trailing short Motion before LayoutClear must be removed'
  )

  // validateAndFixStory also repairs all 3 issues cleanly
  const { story: fixed } = validateAndFixStory(badConfrontation, v6View, undefined, {
    emotionLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  })
  const deflect1 = fixed.snippets.find((s) => s.type === 'Talk' && s.data.content.includes('吓一跳'))
  const deflect2 = fixed.snippets.find((s) => s.type === 'Talk' && s.data.content.includes('天台的风'))
  const enaListenerAct = deflect1.data.actions.find((a) => a.modelId === 2)
  assert.notEqual(enaListenerAct.facial, 'face_smile_01', 'angry listener must not snap to smile')
  assert.ok(['face_serious_01', 'face_trouble_01', 'face_sad_01'].includes(enaListenerAct.facial))
  const mizAct1 = deflect1.data.actions.find((a) => a.modelId === 1)
  assert.notEqual(mizAct1.motion, 'w-normal-glad02')
  assert.notEqual(mizAct1.facial, 'face_smile_01')
  assert.notEqual(mizAct1.facial, 'face_smug_01')
  const mizAct2 = deflect2.data.actions.find((a) => a.modelId === 1)
  assert.notEqual(mizAct2.motion, 'w-adult-delicious01')
  assert.equal(fixed.snippets.filter((s) => s.type === 'Motion').length, 0)
  const postAudit = auditStoryActingAndFidelity(fixed, v6View)
  assert.equal(postAudit.passed, true, `unexpected diagnostics: ${JSON.stringify(postAudit.diagnostics)}`)
})

const V6_PATH = 'D:/Users/桌面/mzkbot/MySekaiStoryteller/apifile/script-1795686273888-gkv7p0.json'
test(
  'regression: v6 apifile/script-1795686273888-gkv7p0.json issues (#34/#37/#66) are caught and repaired cleanly',
  { skip: (!fs.existsSync(V6_PATH) || !hasLocalModels) && 'v6 fixture or local models not present' },
  () => {
    const rawV6 = JSON.parse(fs.readFileSync(V6_PATH, 'utf8'))
    const preAudit = auditStoryActingAndFidelity(rawV6)
    assert.equal(preAudit.passed, false)
    assert.ok(preAudit.diagnostics.some((d) => d.snippetIndex === 34 && d.code === 'listener_forced_smile'))
    assert.ok(
      preAudit.diagnostics.some((d) => d.snippetIndex === 37 && d.code === 'food_motion_without_food_context')
    )
    assert.ok(preAudit.officialReport.issues.some((iss) => iss.includes('snippets[66]')))

    // Build real catalog view from local models for repair
    const loadClips = (rel) => {
      const dir = `${LOCAL_MODELS_ROOT}/${rel.replace(/\/[^/]+$/, '')}/motions`
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.motion3.json'))
        .map((f) => f.replace(/\.motion3\.json$/, ''))
      return {
        facials: files.filter((f) => f.startsWith('face_')),
        motions: files.filter((f) => !f.startsWith('face_'))
      }
    }
    const miz = loadClips(rawV6.models[0].model)
    const ena = loadClips(rawV6.models[1].model)
    const realView = new CatalogView({
      models: [
        {
          id: 1,
          name: '晓山瑞希',
          shortName: '瑞希',
          path: rawV6.models[0].model,
          motions: miz.motions,
          facials: miz.facials,
          defaultMotion: 'w-normal-default01',
          defaultFacial: 'face_normal_01'
        },
        {
          id: 2,
          name: '东云绘名',
          shortName: '绘名',
          path: rawV6.models[1].model,
          motions: ena.motions,
          facials: ena.facials,
          defaultMotion: 'w-normal-default01',
          defaultFacial: 'face_normal_01'
        }
      ],
      images: rawV6.images.map((im) => im.image),
      imageDetails: [],
      voices: [],
      bgm: ['bgm00297.mp3'],
      bgmDetails: []
    })

    const { story: fixedV6, lint } = validateAndFixStory(rawV6, realView, undefined, {
      emotionLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
    })
    assert.equal(lint.passed, true, `unexpected lint issues: ${lint.issues.join('; ')}`)
    const postAudit = auditStoryActingAndFidelity(fixedV6, realView)
    assert.equal(postAudit.passed, true, `unexpected diagnostics: ${JSON.stringify(postAudit.diagnostics)}`)

    const talk34 = fixedV6.snippets.find((s) => s.type === 'Talk' && s.data.content.includes('吓一跳'))
    assert.notEqual(talk34.data.actions.find((a) => a.modelId === 2).facial, 'face_smile_01')
    const miz34Facial = talk34.data.actions.find((a) => a.modelId === 1).facial
    assert.notEqual(miz34Facial, 'face_smile_01')
    assert.equal(inspectModelFacial(rawV6.models[0].model, miz34Facial, LOCAL_MODELS_ROOT).role, 'wry_smile')
    const talk37 = fixedV6.snippets.find((s) => s.type === 'Talk' && s.data.content.includes('天台的风'))
    assert.notEqual(talk37.data.actions.find((a) => a.modelId === 1).motion, 'w-adult-delicious01')
    assert.equal(
      fixedV6.snippets.some(
        (s, idx) =>
          s.type === 'Motion' &&
          s.data?.motion === 'w-cool-sad01' &&
          fixedV6.snippets[idx + 1]?.type === 'LayoutClear'
      ),
      false
    )
  }
)

test('comedy over-guard regression: mock-angry banter in happy-dominated comedy preserves w-happy-wandahoi01', () => {
  const comedyView = new CatalogView({
    models: [
      {
        id: 18,
        name: '天马司',
        shortName: '司',
        path: '18tsukasa_normal/18tsukasa_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-glad01', 'm-tsukasa-wandahoi01'],
        facials: ['face_normal_01', 'face_smile_01', 'face_angry_01', 'face_surprise_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 19,
        name: '凤笑梦',
        shortName: '笑梦',
        path: '19emu_normal/19emu_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-glad02', 'w-happy-wandahoi01'],
        facials: ['face_normal_01', 'face_smile_01', 'face_sparkling_01', 'face_closeeye_02'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['bg_cafe.jpg'],
    imageDetails: [{ file: 'bg_cafe.jpg', name: '甜品店', description: '甜品店' }],
    voices: [],
    bgm: ['bgm00003.mp3'],
    bgmDetails: [{ file: 'bgm00003.mp3', name: 'Slapstick!!', description: '日常喜剧' }]
  })

  const comedyStory = {
    models: [
      { id: 18, model: comedyView.models[0].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 19, model: comedyView.models[1].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_cafe.jpg' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, progressBehavior: 'Now', delay: 0, data: { mode: 'Normal' } },
      { type: 'ChangeBackgroundImage', wait: false, progressBehavior: 'Now', delay: 0, data: { imageId: 1 } },
      {
        type: 'LayoutAppear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: 18, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 }, motion: 'w-normal-glad01', facial: 'face_smile_01' }
      },
      {
        type: 'LayoutAppear',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: 19, from: { side: 'Right', offset: 0 }, to: { side: 'Right', offset: 0 }, motion: 'w-normal-glad02', facial: 'face_sparkling_01' }
      },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '司', emotion: '开心', content: '限定特大彩虹圣代太棒了！', modelId: 18, actions: [{ at: 0, modelId: 18, motion: 'w-normal-glad01', facial: 'face_smile_01' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '笑梦', emotion: '开心', content: '我们来即兴排练吧♪', modelId: 19, actions: [{ at: 0, modelId: 19, motion: 'w-normal-glad02', facial: 'face_sparkling_01' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '司', emotion: '开心', content: '哼哈哈哈，绝不让步！', modelId: 18, actions: [{ at: 0, modelId: 18, motion: 'w-normal-nod01', facial: 'face_smile_01' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '笑梦', emotion: '开心', content: '好冰好甜好好吃～♪', modelId: 19, actions: [{ at: 0, modelId: 19, motion: 'w-normal-nod01', facial: 'face_closeeye_02' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '司', emotion: '生气', content: '喂！！你刚刚是不是顺手挖走了三分之一的奶油啊？！', modelId: 18, actions: [{ at: 0, modelId: 18, facial: 'face_angry_01' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '司', emotion: '生气', content: '这根本不在剧本里！！看我守住顶上那颗大草莓！！', modelId: 18, actions: [{ at: 0, modelId: 18, facial: 'face_angry_01' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '笑梦', emotion: '开心', content: '才不是抢吃，这是即兴演出呀司君！', modelId: 19, actions: [{ at: 0, modelId: 19, motion: 'w-normal-nod01', facial: 'face_closeeye_02' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '笑梦', emotion: '开心', content: '那就用最终合体技分胜负吧！司君，一、二——Wonderhoy！！', modelId: 19, actions: [{ at: 0, modelId: 19, motion: 'w-happy-wandahoi01', facial: 'face_sparkling_01' }] } },
      { type: 'Talk', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { speaker: '司', emotion: '开心', content: '哈哈，太棒了！以后继续加油！', modelId: 18, closeWindowOnFinish: true, actions: [{ at: 0, modelId: 18, motion: 'm-tsukasa-wandahoi01', facial: 'face_smile_01' }] } },
      { type: 'LayoutClear', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { modelId: 18, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 } } },
      { type: 'LayoutClear', wait: false, progressBehavior: 'Now', delay: 0, data: { modelId: 19, from: { side: 'Right', offset: 0 }, to: { side: 'Right', offset: 0 } } },
      { type: 'BlackOut', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { duration: 600 } }
    ]
  }

  const { story: fixed } = validateAndFixStory(comedyStory, comedyView, undefined, {
    emotionLabels: ['平静', '开心', '生气', '伤心', '害羞', '惊讶']
  })
  const wonderhoyTalk = fixed.snippets.find((s) => s.type === 'Talk' && s.data.content.includes('Wonderhoy'))
  const emuAct = wonderhoyTalk.data.actions.find((a) => a.modelId === 19)
  assert.equal(
    emuAct.motion,
    'w-happy-wandahoi01',
    'mock-angry banter in happy-dominated comedy must not replace w-happy-wandahoi01 with w-normal-glad02'
  )
})
