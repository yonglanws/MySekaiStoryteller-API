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
  pickMoodMatchedMotion,
  recommendActingForLine
} from '../../out-host/host/ai/facialSemantics.js'
import { auditStoryActingAndFidelity } from '../../out-host/host/ai/officialLinter.js'
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
