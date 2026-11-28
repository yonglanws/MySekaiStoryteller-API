import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  classifyBgmSekaiScope,
  detectSceneSekaiContext,
  guardSceneBgmSelection,
  isBgmAllowedInScene,
  isSekaiExclusiveBgm,
  sanitizeStorySekaiBgms
} from '../../out-host/host/ai/bgmGuard.js'
import { CatalogView, formatBgmPromptLine } from '../../out-host/host/ai/prompt.js'
import {
  buildStagingPrompt,
  fallbackStaging,
  normalizeStaging,
  pickOpeningBgmForScene
} from '../../out-host/host/ai/staged/staging.js'
import { executeResearchTool } from '../../out-host/host/ai/agent/toolkitResearch.js'

const bgmSemanticsJson = JSON.parse(
  fs.readFileSync(path.resolve('src/host/assets/bgm-semantics.json'), 'utf-8')
)
const backgroundNamesJson = JSON.parse(
  fs.readFileSync(path.resolve('src/host/assets/background-names.json'), 'utf-8')
)

function buildFullSemanticsCatalogView() {
  const bgmDetails = Object.entries(bgmSemanticsJson.tracks).map(([id, meta]) => ({
    id,
    file: `cloud/${id}.mp3`,
    name: meta.name,
    description: meta.description,
    mood: meta.mood,
    tempo: meta.tempo,
    category: meta.category,
    unit: meta.unit,
    tags: meta.tags,
    source: 'cloud'
  }))

  const imageDetails = Object.entries(backgroundNamesJson.backgrounds).map(([id, meta]) => ({
    id,
    file: `cloud/${id}`,
    name: meta.name,
    aliases: meta.aliases ?? [],
    description: `${meta.name}（${meta.category ?? ''}）`,
    category: meta.category,
    timeOfDay: meta.timeOfDay,
    indoor: meta.indoor,
    tags: meta.tags ?? [],
    source: 'cloud'
  }))

  return new CatalogView({
    models: [
      {
        id: 2278,
        name: '东云绘名',
        shortName: '绘名',
        unit: '25时，Nightcord de.',
        path: 'cloud/v2_19ena_casual/19ena_clathes2_4_t07/19ena_clathes2_4_t07.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-sad01'],
        facials: ['face_normal_01', 'face_tired_01', 'face_angry_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 2165,
        name: '东云彰人',
        shortName: '彰人',
        unit: 'Vivid BAD SQUAD',
        path: 'cloud/v2_11akito_casual/v2_11akito_casual_t12/v2_11akito_casual_t12.model3.json',
        motions: ['m-normal-default01', 'm-normal-nod01'],
        facials: ['face_normal_01', 'face_angry_01'],
        defaultMotion: 'm-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: imageDetails.map((d) => d.file),
    imageDetails,
    voices: [],
    bgm: bgmDetails.map((d) => d.file),
    bgmDetails,
    seDetails: []
  })
}

const fullView = buildFullSemanticsCatalogView()

test('bgm-semantics.json marks all 5 unit SEKAI area BGMs and untitled themes as SEKAI-only', () => {
  const expectedUnitMap = {
    bgm_area00001: 'classroom',
    bgm_area00002: 'stage',
    bgm_area00003: 'street',
    bgm_area00004: 'wonderland',
    bgm_area00005: 'empty',
    leoneed_untitled: 'classroom',
    leoneed_untitled_2: 'classroom',
    bgm_area_leoneed_untitled_2: 'classroom',
    moremore_untitled: 'stage',
    moremore_untitled_2: 'stage',
    bgm_area_moremore_untitled_2: 'stage',
    vividbad_untitled: 'street',
    vividbad_untitled_2: 'street',
    wonderlands_untitled: 'wonderland',
    wonderlands_untitled_2: 'wonderland',
    nightcode_untitled: 'empty',
    nightcode_untitled_2: 'empty',
    bgm_area_bigtree: 'generic',
    bgm_area_wishtree: 'generic',
    bgm_area_movie_2025: 'generic',
    bgm00036: 'generic',
    bgm10001: 'generic',
    bgm10005: 'generic'
  }

  for (const [id, expectedUnit] of Object.entries(expectedUnitMap)) {
    const meta = bgmSemanticsJson.tracks[id]
    assert.ok(meta, `track ${id} should exist in bgm-semantics.json`)
    assert.match(meta.description, /仅限.*SEKAI/, `${id} description should warn SEKAI-only`)
    assert.ok(
      (meta.tags ?? []).includes('仅限对应SEKAI场景'),
      `${id} tags should include 仅限对应SEKAI场景`
    )
    const cls = classifyBgmSekaiScope(`cloud/${id}.mp3`, meta)
    assert.equal(cls.isSekaiExclusive, true, `${id} should be SEKAI-exclusive`)
    assert.equal(cls.sekaiUnit, expectedUnit, `${id} should map to ${expectedUnit}`)
  }

  // Real-world tracks must remain unrestricted
  for (const safeId of [
    'normal_area',
    'bgm00003',
    'bgm00006',
    'bgm00016',
    'bgm00018',
    'bgm00021',
    'bgm00029',
    'bgm00054',
    'bgm00055',
    'bgm00065',
    'bgm00082',
    'bgm00113',
    'bgm00169',
    'bgm00173'
  ]) {
    const cls = classifyBgmSekaiScope(`cloud/${safeId}.mp3`, bgmSemanticsJson.tracks[safeId])
    assert.equal(cls.isRestricted, false, `real-world track ${safeId} must NOT be restricted`)
  }
})

test('reproduces exact script_patch.json bug: bgm_area00005 in 东云家 客厅 (bg_e001003) is caught and replaced with real-world quiet night BGM', () => {
  const patchStory = {
    models: [
      {
        id: 2278,
        model: 'cloud/v2_19ena_casual/19ena_clathes2_4_t07/19ena_clathes2_4_t07.model3.json'
      },
      {
        id: 2165,
        model: 'cloud/v2_11akito_casual/v2_11akito_casual_t12/v2_11akito_casual_t12.model3.json'
      }
    ],
    images: [{ id: 1, image: 'cloud/bg_e001003' }],
    snippets: [
      // Exact opening sequence from script_patch.json: ChangeBgm BEFORE ChangeBackgroundImage & PlaceInfo!
      {
        type: 'ChangeBgm',
        wait: true,
        delay: 0,
        data: { file: 'cloud/bgm_area00005.mp3', stop: false, fadeMs: 600, volume: 1 }
      },
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 0, color: 'black' } },
      { type: 'ChangeBackgroundImage', wait: true, delay: 0, data: { imageId: 1 } },
      { type: 'BlackIn', wait: true, delay: 0, data: { duration: 600, color: 'black' } },
      { type: 'PlaceInfo', wait: false, delay: 0, data: { text: '东云家 客厅' } },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '绘名',
          content: '唉……肩膀好酸，那块阴影怎么涂都不对劲……',
          modelId: 2278,
          voice: '',
          ttsText: '',
          emotion: '平静',
          ttsCaption: '',
          motion: '',
          facial: ''
        }
      },
      {
        type: 'ChangeBgm',
        wait: true,
        delay: 0,
        data: { file: '', stop: true, fadeMs: 600, volume: 1 }
      },
      {
        type: 'ChangeBgm',
        wait: true,
        delay: 0,
        data: { file: 'cloud/bgm00054.mp3', stop: false, fadeMs: 600, volume: 1 }
      },
      {
        type: 'ChangeBgm',
        wait: true,
        delay: 0,
        data: { file: 'cloud/bgm00113.mp3', stop: false, fadeMs: 600, volume: 1 }
      }
    ]
  }

  const result = sanitizeStorySekaiBgms(patchStory, fullView, {
    promptText: '深夜绘名画完画去客厅找布丁，发现被彰人吃掉了，姐弟拌嘴'
  })

  assert.equal(result.replaced.length, 1, 'only the opening Empty SEKAI BGM should be replaced')
  assert.equal(result.replaced[0].snippetIndex, 0)
  assert.equal(result.replaced[0].originalFile, 'cloud/bgm_area00005.mp3')

  const replacedFile = patchStory.snippets[0].data.file
  assert.notEqual(replacedFile, 'cloud/bgm_area00005.mp3')
  assert.equal(
    isSekaiExclusiveBgm(replacedFile),
    false,
    `replacement ${replacedFile} must be a real-world BGM`
  )
  const replacedDetail = fullView.bgmDetailsList().find((b) => b.file === replacedFile)
  assert.ok(replacedDetail, 'replacement must exist in catalog')
  assert.ok(
    ['宁静深夜', '感伤忧郁', '温暖治愈'].includes(replacedDetail.mood ?? ''),
    `replacement ${replacedFile} (${replacedDetail.name}) should preserve quiet late-night mood, got ${replacedDetail.mood}`
  )

  // Non-SEKAI BGMs and stop snippet must remain untouched
  assert.equal(patchStory.snippets[7].data.stop, true)
  assert.equal(patchStory.snippets[8].data.file, 'cloud/bgm00054.mp3')
  assert.equal(patchStory.snippets[9].data.file, 'cloud/bgm00113.mp3')
})

test('blocks all 5 SEKAI BGM types in real-world scenes including 25-ji bedroom, Nightcord call, family restaurant, school, Shibuya, and Phoenix Wonderland', () => {
  const realWorldCases = [
    {
      label: '25-ji bedroom + Empty SEKAI area BGM',
      bgm: 'cloud/bgm_area00005.mp3',
      scene: { background: 'cloud/bg_e001003', placeInfo: '绘名的房间', promptText: '25时深夜画画' }
    },
    {
      label: 'Nightcord voice call at home + Empty SEKAI untitled',
      bgm: 'cloud/nightcode_untitled.mp3',
      scene: {
        background: 'bg_nightcord_call.jpg',
        placeInfo: 'Nightcord 语音通话',
        promptText: '25时，Nightcord de. 深夜连线讨论作曲'
      }
    },
    {
      label: 'Family restaurant + Empty SEKAI untitled 2',
      bgm: 'cloud/nightcode_untitled_2.mp3',
      scene: { placeInfo: '家庭餐厅', promptText: '绘名和瑞希在家庭餐厅吃甜品' }
    },
    {
      label: 'Real-world school classroom + Classroom SEKAI BGM',
      bgm: 'cloud/leoneed_untitled.mp3',
      scene: {
        background: 'cloud/bg_a000301',
        placeInfo: '宫益坂女子学园 教室',
        promptText: '一歌和咲希放学后在教室聊天'
      }
    },
    {
      label: 'Real-world school classroom + bgm_area00001',
      bgm: 'cloud/bgm_area00001.mp3',
      scene: { background: 'cloud/bg_a000301', placeInfo: '教室' }
    },
    {
      label: 'Real-world practice room + Stage SEKAI BGM',
      bgm: 'cloud/moremore_untitled.mp3',
      scene: { placeInfo: '舞蹈练习室', background: 'bg_practice_room.jpg', promptText: 'MMJ 排练' }
    },
    {
      label: 'Real-world practice room + bgm_area00002',
      bgm: 'cloud/bgm_area00002.mp3',
      scene: { placeInfo: '屋顶天台', background: 'bg_rooftop.jpg' }
    },
    {
      label: 'Real-world Shibuya street + Street SEKAI BGM',
      bgm: 'cloud/vividbad_untitled.mp3',
      scene: { placeInfo: '涩谷 十字路口', background: 'bg_shibuya_street.jpg' }
    },
    {
      label: 'Real-world WEEKEND GARAGE + bgm_area00003',
      bgm: 'cloud/bgm_area00003.mp3',
      scene: { placeInfo: 'WEEKEND GARAGE', promptText: 'VBS 咖啡厅聚会' }
    },
    {
      label: 'Real-world Phoenix Wonderland + Wonderland SEKAI BGM',
      bgm: 'cloud/wonderlands_untitled.mp3',
      scene: { placeInfo: '凤凰仙境乐园', promptText: 'WxS 游乐园排练' }
    },
    {
      label: 'Real-world Phoenix Wonderland + bgm_area00004',
      bgm: 'cloud/bgm_area00004.mp3',
      scene: { placeInfo: '凤凰仙境乐园 奇迹舞台' }
    },
    {
      label: 'Real-world room + generic SEKAI BGM',
      bgm: 'cloud/bgm00036.mp3',
      scene: { background: 'cloud/bg_e001003', placeInfo: '东云家 客厅' }
    },
    {
      label: 'Real-world room + Collab/April Fools BGM',
      bgm: 'cloud/collaboration_sanrio.mp3',
      scene: { background: 'cloud/bg_e001003', placeInfo: '东云家 客厅' }
    }
  ]

  for (const tc of realWorldCases) {
    const decision = guardSceneBgmSelection(fullView, tc.bgm, tc.scene)
    assert.equal(decision.allowed, false, `should block: ${tc.label}`)
    assert.equal(decision.replaced, true, `should replace: ${tc.label}`)
    assert.ok(decision.finalFile, `should find safe replacement for: ${tc.label}`)
    assert.equal(
      classifyBgmSekaiScope(decision.finalFile).isRestricted,
      false,
      `replacement ${decision.finalFile} for ${tc.label} must not be restricted`
    )
  }
})

test('allows matching SEKAI BGMs inside genuine SEKAI scenes and blocks wrong-unit SEKAI BGMs', () => {
  const allowedCases = [
    { bg: 'cloud/bg_e000501', bgm: 'cloud/bgm_area00005.mp3', unit: 'empty' },
    { bg: 'cloud/bg_e000501', bgm: 'cloud/nightcode_untitled.mp3', unit: 'empty' },
    { bg: 'cloud/bg_e000501', bgm: 'cloud/bgm00036.mp3', unit: 'empty' }, // generic SEKAI ok in Empty SEKAI
    { bg: 'cloud/bg_f000101', bgm: 'cloud/leoneed_untitled.mp3', unit: 'classroom' },
    { bg: 'cloud/bg_f000101', bgm: 'cloud/bgm_area00001.mp3', unit: 'classroom' },
    { bg: 'cloud/bg_b001001', bgm: 'cloud/moremore_untitled.mp3', unit: 'stage' },
    { bg: 'cloud/bg_b001001', bgm: 'cloud/bgm_area00002.mp3', unit: 'stage' },
    { bg: 'cloud/bg_c000401', bgm: 'cloud/vividbad_untitled.mp3', unit: 'street' },
    { bg: 'cloud/bg_c000501', bgm: 'cloud/bgm_area00003.mp3', unit: 'street' }, // Crase Cafe is inside Street SEKAI
    { bg: 'cloud/bg_d000401', bgm: 'cloud/wonderlands_untitled.mp3', unit: 'wonderland' },
    { bg: 'cloud/bg_d000401', bgm: 'cloud/bgm_area00004.mp3', unit: 'wonderland' }
  ]

  for (const tc of allowedCases) {
    const ctx = detectSceneSekaiContext({ background: tc.bg }, fullView)
    assert.equal(ctx.isSekai, true, `${tc.bg} should be detected as SEKAI`)
    assert.equal(ctx.sekaiUnit, tc.unit, `${tc.bg} should map to ${tc.unit}`)
    const decision = guardSceneBgmSelection(fullView, tc.bgm, { background: tc.bg })
    assert.equal(decision.allowed, true, `${tc.bgm} should be allowed in ${tc.bg}`)
    assert.equal(decision.finalFile, tc.bgm)
  }

  // Wrong-unit SEKAI BGM inside Empty SEKAI must be blocked and replaced with Empty SEKAI BGM
  const wrongUnit1 = guardSceneBgmSelection(fullView, 'cloud/wonderlands_untitled.mp3', {
    background: 'cloud/bg_e000501',
    placeInfo: '无人「世界」'
  })
  assert.equal(wrongUnit1.allowed, false)
  assert.equal(wrongUnit1.replaced, true)
  assert.equal(
    classifyBgmSekaiScope(wrongUnit1.finalFile).sekaiUnit,
    'empty',
    `wrong-unit Wonderland BGM in Empty SEKAI should be replaced with Empty SEKAI BGM, got ${wrongUnit1.finalFile}`
  )

  // Wrong-unit Empty SEKAI BGM inside Classroom SEKAI must be blocked and replaced with Classroom SEKAI BGM
  const wrongUnit2 = guardSceneBgmSelection(fullView, 'cloud/bgm_area00005.mp3', {
    background: 'cloud/bg_f000101',
    placeInfo: '教室「世界」'
  })
  assert.equal(wrongUnit2.allowed, false)
  assert.equal(wrongUnit2.replaced, true)
  assert.equal(
    classifyBgmSekaiScope(wrongUnit2.finalFile).sekaiUnit,
    'classroom',
    `wrong-unit Empty SEKAI BGM in Classroom SEKAI should be replaced with Classroom SEKAI BGM, got ${wrongUnit2.finalFile}`
  )
})

test('multi-scene story with SekaiIn and SekaiOut enforces worldline BGM boundaries per scene', () => {
  const story = {
    models: [
      {
        id: 2278,
        model: 'cloud/v2_19ena_casual/19ena_clathes2_4_t07/19ena_clathes2_4_t07.model3.json'
      }
    ],
    images: [
      { id: 1, image: 'cloud/bg_e001003' }, // Real-world: 东云家 客厅
      { id: 2, image: 'cloud/bg_e000501' } // Empty SEKAI: 无人「世界」
    ],
    snippets: [
      // Scene 1 (Real world): Empty SEKAI BGM should be blocked
      {
        type: 'ChangeBgm',
        data: { file: 'cloud/bgm_area00005.mp3', stop: false, fadeMs: 600, volume: 1 }
      },
      { type: 'ChangeBackgroundImage', data: { imageId: 1 } },
      { type: 'PlaceInfo', data: { text: '东云家 客厅' } },
      { type: 'Talk', data: { speaker: '绘名', content: '好累啊……', modelId: 2278 } },

      // Scene 2 (Enter Empty SEKAI): Empty SEKAI BGM allowed, Wonderland SEKAI BGM blocked
      { type: 'SekaiIn', data: { duration: 1000 } },
      { type: 'ChangeBackgroundImage', data: { imageId: 2 } },
      { type: 'PlaceInfo', data: { text: '无人「世界」' } },
      {
        type: 'ChangeBgm',
        data: { file: 'cloud/nightcode_untitled.mp3', stop: false, fadeMs: 600, volume: 1 }
      },
      { type: 'Talk', data: { speaker: '绘名', content: '初音，你在吗？', modelId: 2278 } },
      {
        type: 'ChangeBgm',
        data: { file: 'cloud/wonderlands_untitled.mp3', stop: false, fadeMs: 600, volume: 1 }
      },
      { type: 'Talk', data: { speaker: '绘名', content: '这里还是那么安静。', modelId: 2278 } },

      // Scene 3 (Exit back to real world): Empty SEKAI BGM blocked again
      { type: 'SekaiOut', data: { duration: 1000 } },
      { type: 'ChangeBackgroundImage', data: { imageId: 1 } },
      { type: 'PlaceInfo', data: { text: '东云家 客厅' } },
      {
        type: 'ChangeBgm',
        data: { file: 'cloud/bgm_area00005.mp3', stop: false, fadeMs: 600, volume: 1 }
      },
      { type: 'Talk', data: { speaker: '绘名', content: '回来了。', modelId: 2278 } }
    ]
  }

  const res = sanitizeStorySekaiBgms(story, fullView)
  assert.equal(res.replaced.length, 3)
  // Scene 1 replaced with real-world BGM
  assert.equal(isSekaiExclusiveBgm(story.snippets[0].data.file), false)
  // Scene 2 Empty SEKAI BGM kept
  assert.equal(story.snippets[7].data.file, 'cloud/nightcode_untitled.mp3')
  // Scene 2 wrong-unit Wonderland BGM replaced with Empty SEKAI BGM
  assert.equal(classifyBgmSekaiScope(story.snippets[9].data.file).sekaiUnit, 'empty')
  // Scene 3 back in real world replaced with real-world BGM
  assert.equal(isSekaiExclusiveBgm(story.snippets[14].data.file), false)
})

test('CatalogView.bgmPromptChoices, staging.ts, and toolkitResearch search_assets filter and guard SEKAI BGMs', async () => {
  // 1. bgmPromptChoices excludes Empty SEKAI tracks for real-world 25-ji late-night query
  const realChoices = fullView.bgmPromptChoices(36, '东云家 客厅 深夜 绘名 彰人 布丁')
  assert.ok(realChoices.length > 0)
  for (const item of realChoices) {
    assert.equal(
      classifyBgmSekaiScope(item.file, item).isRestricted,
      false,
      `real-world bgmPromptChoices must not include restricted BGM ${item.id}`
    )
  }

  // 2. bgmPromptChoices includes Empty SEKAI tracks (and excludes Wonderland SEKAI tracks) for Empty SEKAI query
  const sekaiChoices = fullView.bgmPromptChoices(36, '无人SEKAI 湖边 深夜 25时')
  assert.ok(
    sekaiChoices.some((b) => classifyBgmSekaiScope(b.file, b).sekaiUnit === 'empty'),
    'Empty SEKAI query should surface Empty SEKAI tracks'
  )
  assert.ok(
    sekaiChoices.every((b) => {
      const cls = classifyBgmSekaiScope(b.file, b)
      return !cls.isRestricted || cls.sekaiUnit === 'empty' || cls.sekaiUnit === 'generic'
    }),
    'Empty SEKAI query must not surface wrong-unit SEKAI tracks'
  )

  // 3. formatBgmPromptLine annotates unbadged restricted tracks
  const customBadgeLine = formatBgmPromptLine({
    id: 'bgm_area00005',
    file: 'cloud/bgm_area00005.mp3',
    name: '心景',
    mood: '宁静深夜',
    tempo: '慢板',
    description: '清冷静谧'
  })
  assert.match(customBadgeLine, /仅限无人SEKAI内使用/)

  // 4. staging.ts: buildStagingPrompt, normalizeStaging, fallbackStaging, pickOpeningBgmForScene
  const plan = {
    title: '布丁风波',
    event: '深夜客厅发现布丁被吃',
    logline: '绘名画完画回客厅找限量布丁，发现被彰人吃掉',
    outline: ['绘名找布丁', '姐弟拌嘴', '彰人答应明天去排队买'],
    cast: [
      { modelId: 2278, name: '绘名', fullName: '东云绘名', path: '', role: '姐姐' },
      { modelId: 2165, name: '彰人', fullName: '东云彰人', path: '', role: '弟弟' }
    ],
    background: 'cloud/bg_e001003',
    scenes: [
      {
        id: 's1',
        summary: '深夜东云家客厅',
        background: 'cloud/bg_e001003',
        ambient: 'night',
        placeInfo: '东云家 客厅',
        transitionIn: 'black',
        activeCast: ['绘名', '彰人'],
        bgm: 'cloud/bgm_area00005.mp3'
      }
    ]
  }
  const dialogue = {
    title: '布丁风波',
    lines: [
      { id: 'l1', speaker: '绘名', content: '唉……肩膀好酸，那块阴影怎么涂都不对劲……' },
      { id: 'l2', speaker: '绘名', content: '算了，先吃掉冰箱里那份限量芝士布丁吧……' },
      { id: 'l3', speaker: '绘名', content: '……咦？空的？' },
      { id: 'l4', speaker: '彰人', content: '吵死了，大半夜鬼叫什么。' },
      { id: 'l5', speaker: '绘名', content: '我的布丁呢？！' },
      { id: 'l6', speaker: '彰人', content: '……被我吃了。' }
    ]
  }

  const promptMsgs = buildStagingPrompt(fullView, plan, dialogue, {
    scene: '深夜绘名画完画在东云家客厅找布丁',
    personas: [],
    targetMinutes: 2
  })
  assert.match(promptMsgs.user, /严禁跨世界线误用 SEKAI 专属 BGM/)
  assert.doesNotMatch(promptMsgs.user, /bgm_area00005（|（bgm_area00005）/)

  const pickedOpening = pickOpeningBgmForScene(fullView, plan, dialogue, '深夜东云家客厅')
  assert.ok(pickedOpening)
  assert.equal(isSekaiExclusiveBgm(pickedOpening), false)

  const fb = fallbackStaging(fullView, plan, dialogue)
  assert.equal(isSekaiExclusiveBgm(fb.scenes[0].bgm), false)

  const normalized = normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'cloud/bg_e001003',
          ambient: 'night',
          placeInfo: '东云家 客厅',
          transitionIn: 'black',
          activeCast: ['绘名', '彰人'],
          bgm: 'bgm_area00005'
        }
      ],
      events: [
        {
          lineId: 'l4',
          bgmCut: { action: 'play', file: 'nightcode_untitled', fadeMs: 600 }
        }
      ]
    },
    fullView,
    plan,
    dialogue
  )
  assert.notEqual(normalized.scenes[0].bgm, 'cloud/bgm_area00005.mp3')
  assert.equal(isSekaiExclusiveBgm(normalized.scenes[0].bgm), false)
  const bgmCutEv = normalized.events.find((e) => e.lineId === 'l4')
  assert.ok(bgmCutEv?.bgmCut?.file)
  assert.equal(isSekaiExclusiveBgm(bgmCutEv.bgmCut.file), false)

  // 5. toolkitResearch search_assets
  const mockCtx = {
    view: fullView,
    personas: [],
    ragRetriever: null,
    logger: { debug() {}, info() {}, warn() {} },
    state: {}
  }

  const realResearchRaw = await executeResearchTool(mockCtx, 'search_assets', {
    kind: 'bgm',
    query: '深夜 绘名 客厅 25时',
    limit: 12
  })
  const realResearch = JSON.parse(realResearchRaw)
  assert.ok(realResearch.bgm.length > 0)
  for (const item of realResearch.bgm) {
    assert.equal(
      classifyBgmSekaiScope(item.file, item).isRestricted,
      false,
      `search_assets real-world query must not return restricted BGM ${item.file}`
    )
  }

  const sekaiResearchRaw = await executeResearchTool(mockCtx, 'search_assets', {
    kind: 'bgm',
    query: '无人SEKAI 深夜',
    limit: 12
  })
  const sekaiResearch = JSON.parse(sekaiResearchRaw)
  const emptySekaiItem = sekaiResearch.bgm.find((item) => item.sekaiOnly === true)
  assert.ok(emptySekaiItem, 'SEKAI query should return tagged SEKAI BGM')
  assert.equal(emptySekaiItem.sekaiScope, '无人SEKAI')
  assert.match(emptySekaiItem.usageWarning, /仅限无人SEKAI内使用/)
  assert.equal(
    sekaiResearch.bgm.some((item) => classifyBgmSekaiScope(item.file).sekaiUnit === 'wonderland'),
    false,
    'Empty SEKAI query must not return Wonderland SEKAI BGMs'
  )
})

test('isBgmAllowedInScene handles generic SEKAI vs specific SEKAI correctly', () => {
  const realCtx = detectSceneSekaiContext({ placeInfo: '家庭餐厅' }, fullView)
  const emptyCtx = detectSceneSekaiContext({ background: 'cloud/bg_e000501' }, fullView)
  const genericCtx = detectSceneSekaiContext({ background: 'cloud/bg_g000601' }, fullView) // 心愿之树「世界」

  assert.equal(isBgmAllowedInScene('cloud/bgm_area00005.mp3', realCtx), false)
  assert.equal(isBgmAllowedInScene('cloud/bgm_area00005.mp3', emptyCtx), true)
  assert.equal(isBgmAllowedInScene('cloud/bgm00036.mp3', emptyCtx), true)
  assert.equal(isBgmAllowedInScene('cloud/bgm_area_wishtree.mp3', genericCtx), true)
  assert.equal(isBgmAllowedInScene('cloud/bgm_area00005.mp3', genericCtx), false)
})
