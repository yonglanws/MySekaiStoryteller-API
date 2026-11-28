import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectModelMotion,
  isMotionAutoPickAllowed,
  isMotionCompatibleWithLine,
  pickMoodMatchedMotion,
  pickMoodMatchedFacial,
  recommendActingForLine
} from '../../out-host/host/ai/facialSemantics.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import {
  buildCastPrompt,
  buildStagingPrompt,
  composeStory,
  normalizeStaging,
  applyVoiceDirectionPlan
} from '../../out-host/host/ai/staged.js'

const MAFUMOM_MOTIONS = [
  's-common-nod01',
  's-common-angry01',
  's-common-sad01',
  's-common-forward01',
  's-common-lookdown01',
  's-common-shakehead01',
  's-common-glad01',
  's-common-surprise01',
  's-common-trouble01'
]

const KAITO_NIGHT_FACIALS = [
  'face_normal_01',
  'face_angry_01',
  'face_serious_01',
  'face_sad_01',
  'face_closeeye_01',
  'face_night_normal',
  'face_night_angry',
  'face_night_serious',
  'face_night_sad',
  'face_night_closeeye'
]

function makeView() {
  return new CatalogView({
    models: [
      {
        id: 18,
        name: '朝比奈真冬',
        shortName: '真冬',
        characterId: 18,
        path: 'models/cloud/18mafuyu_normal/18mafuyu_normal.model3.json',
        motions: ['w-normal-nod01', 'w-normal-sad01', 'w-normal-lookdown01', 'w-normal-forward01'],
        facials: ['face_normal_01', 'face_sad_01', 'face_serious_01', 'face_trouble_01']
      },
      {
        id: 26,
        name: 'KAITO（无人世界）',
        shortName: 'KAITO',
        characterId: 26,
        path: 'models/cloud/26kaito_night/26kaito_night.model3.json',
        motions: [
          'm-normal-nod01',
          'm-normal-angry01',
          'm-normal-forward01',
          'm-normal-shakehead01'
        ],
        facials: KAITO_NIGHT_FACIALS
      },
      {
        id: 901,
        name: '真冬的母亲',
        shortName: '真冬母亲',
        path: 'models/cloud/sub_mafuyumother/sub_mafuyumother_t05/sub_mafuyumother_t05.model3.json',
        motions: MAFUMOM_MOTIONS,
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_serious_01',
          'face_sad_01',
          'face_trouble_01'
        ]
      }
    ],
    images: ['cloud/bg_e000204', 'cloud/bg_e001101'],
    imageDetails: [
      {
        file: 'cloud/bg_e000204',
        name: '朝比奈家 客厅',
        category: '住宅与房间',
        timeOfDay: '夜晚'
      },
      {
        file: 'cloud/bg_e001101',
        name: '无人的「世界」',
        category: 'SEKAI',
        timeOfDay: '通用'
      }
    ],
    bgms: [
      'cloud/bgm00065.mp3',
      'cloud/bgm00039.mp3',
      'cloud/bgm00027.mp3',
      'cloud/bgm00156.mp3',
      'cloud/bgm00029.mp3',
      'cloud/bgm00054.mp3'
    ],
    bgmDetails: [
      {
        file: 'cloud/bgm00065.mp3',
        id: 'bgm00065',
        name: '存在する孤独',
        category: '压抑',
        mood: '寂静低落'
      },
      {
        file: 'cloud/bgm00039.mp3',
        id: 'bgm00039',
        name: '紧迫对峙',
        category: '紧张',
        mood: '紧张对峙'
      },
      {
        file: 'cloud/bgm00027.mp3',
        id: 'bgm00027',
        name: '沉重真相',
        category: '沉重',
        mood: '沉重压抑'
      },
      {
        file: 'cloud/bgm00156.mp3',
        id: 'bgm00156',
        name: '静夜余韵',
        category: '平静',
        mood: '静谧思考'
      },
      {
        file: 'cloud/bgm00029.mp3',
        id: 'bgm00029',
        name: '愛しい人へ',
        category: '抒情',
        mood: '温柔抒情'
      },
      {
        file: 'cloud/bgm00054.mp3',
        id: 'bgm00054',
        name: 'Not Bad Afternoon',
        category: '日常',
        mood: '轻快日常'
      }
    ],
    ses: []
  })
}

test('sub_* NPC s-common-* body motions are classified normally and never blocked as special', () => {
  const modelPath =
    'models/cloud/sub_mafuyumother/sub_mafuyumother_t05/sub_mafuyumother_t05.model3.json'
  assert.equal(inspectModelMotion(modelPath, 's-common-nod01').role, 'nod')
  assert.equal(inspectModelMotion(modelPath, 's-common-angry01').role, 'angry')
  assert.equal(inspectModelMotion(modelPath, 's-common-sad01').role, 'sad')
  assert.equal(inspectModelMotion(modelPath, 's-common-lookdown01').role, 'sad')
  assert.equal(inspectModelMotion(modelPath, 's-common-shakehead01').role, 'shakehead')
  assert.equal(inspectModelMotion(modelPath, 's-common-forward01').role, 'forward')
  // Non s-common special poses remain special
  assert.equal(inspectModelMotion(modelPath, 's-special-sit01').role, 'special')

  for (const m of MAFUMOM_MOTIONS) {
    assert.equal(isMotionAutoPickAllowed(m, modelPath), true, `expected ${m} auto-pick allowed`)
  }
  const compat = isMotionCompatibleWithLine({
    motion: 's-common-nod01',
    modelPath,
    emotion: '平静',
    content: '真冬只是最近压力太大了，请不要再打扰她。'
  })
  assert.equal(compat.ok, true)

  const picked = pickMoodMatchedMotion(MAFUMOM_MOTIONS, 'sad_regret', modelPath)
  assert.ok(picked === 's-common-sad01' || picked === 's-common-lookdown01', `got ${picked}`)
})

test('26kaito_night prefers face_night_* variant facials over generic face_* for same role', () => {
  const modelPath = 'models/cloud/26kaito_night/26kaito_night.model3.json'
  const angryFacial = pickMoodMatchedFacial(KAITO_NIGHT_FACIALS, 'angry', modelPath, true)
  assert.equal(angryFacial, 'face_night_angry')

  const rec = recommendActingForLine({
    facials: KAITO_NIGHT_FACIALS,
    motions: ['m-normal-angry01', 'm-normal-forward01'],
    modelPath,
    content: '——吵死了。别再自欺欺人了。',
    emotion: '生气',
    restrainedRole: true
  })
  assert.equal(rec.facials[0], 'face_night_angry')
})

test('composer preserves hologram shader across intra-scene solo cutaways and resets on scene transition', () => {
  const view = makeView()
  const plan = {
    title: '客厅对峙',
    logline: 'KAITO 在客厅以全息现身与母亲对话',
    event: '深夜客厅全息对峙',
    background: 'cloud/bg_e000204',
    cast: [
      { modelId: 26, name: 'KAITO', fullName: 'KAITO（无人世界）', role: '对峙' },
      { modelId: 901, name: '真冬母亲', fullName: '真冬的母亲', role: '质问' }
    ],
    scenes: [
      {
        id: 's1',
        summary: '客厅对峙',
        background: 'cloud/bg_e000204',
        ambient: 'night',
        activeCast: ['KAITO', '真冬母亲'],
        bgm: 'cloud/bgm00065.mp3'
      },
      {
        id: 's2',
        summary: '回到无人世界',
        background: 'cloud/bg_e001101',
        ambient: 'normal',
        transitionIn: 'sekaiIn',
        isSekai: true,
        activeCast: ['KAITO'],
        bgm: 'keep'
      }
    ],
    outline: ['全息现身', '母亲特写', '恢复双人对峙', '回到世界']
  }
  const dialogue = {
    title: '客厅对峙',
    lines: [
      {
        id: 'l1',
        sceneId: 's1',
        speaker: 'KAITO',
        content: '你从来没有真正听过她说话。',
        emotion: '平静'
      },
      {
        id: 'l2',
        sceneId: 's1',
        speaker: '真冬母亲',
        content: '（……这个人到底是怎么出现在客厅里的？）',
        emotion: '平静',
        windowDisplayMode: 'Thinking'
      },
      {
        id: 'l3',
        sceneId: 's1',
        speaker: '真冬母亲',
        content: '请你立刻离开我家。',
        emotion: '平静'
      },
      { id: 'l4', sceneId: 's1', speaker: 'KAITO', content: '逃避现实的是你。', emotion: '生气' },
      { id: 'l5', sceneId: 's2', speaker: 'KAITO', content: '……真是麻烦。', emotion: '平静' }
    ]
  }
  const staging = {
    scenes: [
      {
        id: 's1',
        fromIndex: 0,
        background: 'cloud/bg_e000204',
        ambient: 'night',
        transitionIn: 'black',
        activeCast: [26, 901],
        hologramCast: [26],
        bgm: 'cloud/bgm00065.mp3'
      },
      {
        id: 's2',
        fromIndex: 4,
        background: 'cloud/bg_e001101',
        ambient: 'normal',
        transitionIn: 'sekaiIn',
        isSekai: true,
        activeCast: [26],
        hologramCast: [],
        bgm: 'keep'
      }
    ],
    events: [
      {
        lineId: 'l2',
        lineIndex: 1,
        stageGroup: { activeCast: [901] }
      }
    ]
  }
  const direction = {
    background: 'cloud/bg_e000204',
    ambient: 'night',
    lines: dialogue.lines.map((l) => ({ id: l.id, motion: '', facial: 'face_normal_01' }))
  }

  const story = composeStory(view, plan, dialogue, direction, staging)
  const kaitoAppears = story.snippets.filter(
    (s) => s.type === 'LayoutAppear' && s.data?.modelId === 26
  )
  // s1 initial appear (hologram), s1 re-appear after solo cutaway (STILL hologram!), s2 SEKAI appear (solid)
  assert.equal(kaitoAppears.length, 3)
  assert.equal(kaitoAppears[0].data.hologram, true)
  assert.equal(kaitoAppears[1].data.hologram, true, 'intra-scene re-appear must retain hologram')
  assert.equal(
    kaitoAppears[2].data.hologram,
    false,
    'SEKAI scene transition resets hologram to solid'
  )
})

test('composer does not resurrect an explicitly exited character after solo thinking monologue (g4lre8 #94)', () => {
  const view = makeView()
  const plan = {
    title: '余韵',
    logline: 'KAITO 离场回世界后真冬独自收尾',
    event: '离场后的独白',
    background: 'cloud/bg_e000204',
    cast: [
      { modelId: 18, name: '真冬', fullName: '朝比奈真冬', role: '主角' },
      { modelId: 26, name: 'KAITO', fullName: 'KAITO（无人世界）', role: '离开' }
    ],
    scenes: [
      {
        id: 's1',
        summary: '房间',
        background: 'cloud/bg_e000204',
        ambient: 'night',
        activeCast: ['真冬', 'KAITO'],
        bgm: 'cloud/bgm00065.mp3'
      }
    ],
    outline: ['对话', 'KAITO 回到世界', '真冬内心独白', '真冬轻声收尾']
  }
  const dialogue = {
    title: '余韵',
    lines: [
      {
        id: 'l1',
        sceneId: 's1',
        speaker: 'KAITO',
        content: '你已经做了你该做的。我回去了。',
        emotion: '平静'
      },
      {
        id: 'l2',
        sceneId: 's1',
        speaker: '真冬',
        content: '（……KAITO已经回到「世界」里去了。）',
        emotion: '平静',
        windowDisplayMode: 'Thinking'
      },
      { id: 'l3', sceneId: 's1', speaker: '真冬', content: '……明天，也去一次吧。', emotion: '平静' }
    ]
  }
  const staging = {
    scenes: [
      {
        id: 's1',
        fromIndex: 0,
        background: 'cloud/bg_e000204',
        ambient: 'night',
        transitionIn: 'black',
        activeCast: [18, 26],
        bgm: 'cloud/bgm00065.mp3'
      }
    ],
    events: [
      {
        lineId: 'l2',
        lineIndex: 1,
        stageGroup: { activeCast: [18] }
      }
    ]
  }
  const direction = {
    background: 'cloud/bg_e000204',
    ambient: 'night',
    lines: dialogue.lines.map((l) => ({ id: l.id, motion: '', facial: 'face_normal_01' }))
  }

  const story = composeStory(view, plan, dialogue, direction, staging)
  const kaitoAppears = story.snippets.filter(
    (s) => s.type === 'LayoutAppear' && s.data?.modelId === 26
  )
  // KAITO enters once at opening and is NEVER pulled back on screen for l3!
  assert.equal(
    kaitoAppears.length,
    1,
    'exited KAITO must not be resurrected after thinking monologue'
  )
})

test('enrichStagingBaseline caps excessive BGM churn in ~34-line scripts to <= 4 plays while preserving STOP recovery', () => {
  const view = makeView()
  const lines = Array.from({ length: 34 }, (_, i) => ({
    id: `l${i + 1}`,
    sceneId: 's1',
    speaker: i % 2 === 0 ? 'KAITO' : '真冬母亲',
    content: `第${i + 1}句台词。`,
    emotion: '平静'
  }))
  const plan = {
    title: '客厅对峙',
    logline: '长对峙',
    event: '对峙',
    background: 'cloud/bg_e000204',
    cast: [
      { modelId: 26, name: 'KAITO', fullName: 'KAITO（无人世界）', role: '对峙' },
      { modelId: 901, name: '真冬母亲', fullName: '真冬的母亲', role: '回应' }
    ],
    scenes: [
      {
        id: 's1',
        summary: '客厅对峙',
        background: 'cloud/bg_e000204',
        ambient: 'night',
        activeCast: ['KAITO', '真冬母亲'],
        bgm: 'cloud/bgm00065.mp3'
      }
    ],
    outline: ['a', 'b', 'c', 'd']
  }
  const rawStaging = {
    scenes: [
      {
        id: 's1',
        fromLineId: 'l1',
        background: 'cloud/bg_e000204',
        ambient: 'night',
        transitionIn: 'black',
        activeCast: ['KAITO', '真冬母亲'],
        bgm: 'bgm00065'
      }
    ],
    events: [
      { lineId: 'l3', bgmCut: { action: 'play', file: 'bgm00039', fadeMs: 800 } },
      { lineId: 'l8', bgmCut: { action: 'play', file: 'bgm00027', fadeMs: 800 } },
      { lineId: 'l14', bgmCut: { action: 'play', file: 'bgm00156', fadeMs: 800 } },
      { lineId: 'l19', bgmCut: { action: 'stop', fadeMs: 500 } },
      { lineId: 'l22', bgmCut: { action: 'play', file: 'bgm00029', fadeMs: 800 } },
      { lineId: 'l27', bgmCut: { action: 'play', file: 'bgm00054', fadeMs: 800 } },
      { lineId: 'l31', bgmCut: { action: 'play', file: 'bgm00065', fadeMs: 800 } }
    ]
  }
  const enriched = normalizeStaging(rawStaging, view, plan, { title: '客厅对峙', lines })
  const playCount =
    (enriched.scenes[0].bgm &&
    enriched.scenes[0].bgm !== 'silence' &&
    enriched.scenes[0].bgm !== 'keep'
      ? 1
      : 0) + enriched.events.filter((e) => e.bgmCut?.action === 'play' && e.bgmCut.file).length
  assert.ok(playCount <= 4, `expected <= 4 BGM plays, got ${playCount}`)
  // The recovery play right after l19 STOP must be preserved
  const stopEv = enriched.events.find((e) => e.lineIndex === 18)
  const recoveryEv = enriched.events.find((e) => e.lineIndex === 21)
  assert.equal(stopEv?.bgmCut?.action, 'stop')
  assert.equal(recoveryEv?.bgmCut?.action, 'play')
})

test('applyVoiceDirectionPlan fixes hushed warning happy, relief sad+special, and cold scoff surprise', () => {
  const dialogue = {
    title: '情绪校验',
    lines: [
      { id: 'l1', sceneId: 's1', speaker: '杏', content: '停。别动。', emotion: '' },
      { id: 'l2', sceneId: 's1', speaker: 'KAITO', content: '呵……真是可笑。', emotion: '' },
      {
        id: 'l3',
        sceneId: 's1',
        speaker: '绘名',
        content: '（算了，反正今天这样也挺好的，总算松了口气。）',
        emotion: ''
      }
    ]
  }
  const plan = new Map([
    ['l1', { emotion: '开心', ttsCaption: '慌てて小声で' }],
    ['l2', { emotion: '惊讶', ttsCaption: '冷たく鼻で笑う' }],
    ['l3', { emotion: '伤心', ttsCaption: '穏やかに', ttsSpecialScene: true }]
  ])
  const out = applyVoiceDirectionPlan(dialogue, plan, [
    '平静',
    '开心',
    '生气',
    '伤心',
    '害羞',
    '惊讶'
  ])
  assert.equal(out.lines[0].emotion, '平静')
  assert.equal(out.lines[1].emotion, '平静')
  assert.equal(out.lines[2].emotion, '平静')
  assert.equal(out.lines[2].ttsSpecialScene, undefined)
})

test('cast & staging prompts include 3-way conflict, non-holder SEKAI boundary, and BGM switch cap guidance', () => {
  const view = makeView()
  const castPrompt = buildCastPrompt(view, {
    scene: '真冬母亲和KAITO在客厅对峙',
    targetMinutes: 3,
    personas: []
  })
  assert.match(castPrompt.user, /三方关系冲突/)
  assert.match(castPrompt.user, /非「世界」持有者/)

  const plan = {
    title: '客厅对峙',
    logline: '对峙',
    event: '对峙',
    background: 'cloud/bg_e000204',
    cast: [
      { modelId: 26, name: 'KAITO', fullName: 'KAITO（无人世界）', role: '对峙' },
      { modelId: 901, name: '真冬母亲', fullName: '真冬的母亲', role: '回应' }
    ],
    scenes: [
      {
        id: 's1',
        summary: '客厅对峙',
        background: 'cloud/bg_e000204',
        ambient: 'night',
        activeCast: ['KAITO', '真冬母亲'],
        bgm: 'cloud/bgm00065.mp3'
      }
    ],
    outline: ['a', 'b']
  }
  const stagingPrompt = buildStagingPrompt(
    view,
    plan,
    {
      title: '客厅对峙',
      lines: [
        { id: 'l1', sceneId: 's1', speaker: 'KAITO', content: '你没听过她说话。', emotion: '平静' }
      ]
    },
    { scene: '客厅对峙', targetMinutes: 3, personas: [] }
  )
  assert.match(stagingPrompt.user, /控制在 2~4 首以内/)
  assert.match(stagingPrompt.user, /非「世界」持有者/)
})
