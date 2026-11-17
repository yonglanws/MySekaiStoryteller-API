/**
 * Wave 2 Official PJSK 5-Stage Director Pipeline & Harness Parity Tests.
 * Uses typescript ts.transpileModule + node:vm (matching scripts/audio/acf-mix-and-loop.test.mjs)
 * so it tests live TypeScript sources directly without requiring a pre-built out-host/.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const nodeRequire = createRequire(import.meta.url)

function loadTsModule(targetRel) {
  const modules = new Map()
  const compiled = new Map()
  const context = vm.createContext({
    console,
    Buffer,
    process,
    URL,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    JSON,
    Date,
    Infinity,
    NaN,
    Map,
    Set,
    Promise,
    Error,
    structuredClone,
    TextDecoder,
    TextEncoder
  })

  function resolveFile(fromDir, spec) {
    const raw = path.resolve(fromDir, spec)
    for (const candidate of [raw, `${raw}.ts`, path.join(raw, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return raw
  }

  function load(filePath) {
    const filename = path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
    if (modules.has(filename)) return modules.get(filename)
    if (filename.endsWith('.json')) {
      const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
      modules.set(filename, parsed)
      return parsed
    }
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require, __dirname, __filename) {\n${
            ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true
              },
              fileName: filename
            }).outputText
          }\n})`,
          { filename }
        )
      )
    }
    const exports = {}
    modules.set(filename, exports)
    const require = (spec) => {
      if (!spec.startsWith('.')) return nodeRequire(spec)
      return load(resolveFile(path.dirname(filename), spec))
    }
    compiled.get(filename).runInContext(context)(exports, require, path.dirname(filename), filename)
    return exports
  }

  return load(targetRel)
}

const scenarioCues = loadTsModule('src/host/ai/scenarioCues.ts')
const corpusExamples = loadTsModule('src/host/ai/corpusExamples.ts')
const personas = loadTsModule('src/host/ai/personas.ts')
const promptMod = loadTsModule('src/host/ai/prompt.ts')
const staged = loadTsModule('src/host/ai/staged.ts')
const validate = loadTsModule('src/host/ai/validate.ts')
const linter = loadTsModule('src/host/ai/officialLinter.ts')

function makeEnsembleView() {
  const { CatalogView } = promptMod
  return new CatalogView({
    models: [
      {
        id: 13,
        name: '天马司',
        shortName: '司',
        path: '13tsukasa_normal/13tsukasa_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-glad01', 'w-normal-pose01'],
        facials: ['face_smile_01', 'face_normal_01', 'face_surprise_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 14,
        name: '凤笑梦',
        shortName: '笑梦',
        path: '14emu_normal/14emu_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-glad01', 'w-normal-greeting01'],
        facials: ['face_smile_01', 'face_sparkling_01', 'face_surprise_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 15,
        name: '草薙宁宁',
        shortName: '宁宁',
        path: '15nene_normal/15nene_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-sigh01', 'w-normal-shy01'],
        facials: ['face_normal_01', 'face_trouble_01', 'face_shy_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 16,
        name: '神代类',
        shortName: '类',
        path: '16rui_normal/16rui_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-think01', 'w-normal-nod01'],
        facials: ['face_smile_01', 'face_smug_01', 'face_serious_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 21,
        name: '初音未来',
        shortName: 'MIKU',
        path: '21miku_normal/21miku_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-greeting01', 'w-normal-nod01'],
        facials: ['face_smile_01', 'face_wink_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['bg_stage.jpg', 'bg_sekai_wxs.jpg', 'bg_past_park.jpg'],
    imageDetails: [
      { file: 'bg_stage.jpg', name: '神奇舞台', description: '白天的游乐园奇妙舞台' },
      { file: 'bg_sekai_wxs.jpg', name: '仙境世界', description: '奇幻绚丽的游乐园世界' },
      { file: 'bg_past_park.jpg', name: '昔日公园', description: '柔和的午后回忆公园' }
    ],
    voices: [],
    bgm: ['bgm00003.mp3', 'bgm00010.mp3'],
    bgmDetails: [
      { file: 'bgm00003.mp3', name: '轻松日常', description: '明快的日常群像旋律' },
      { file: 'bgm00010.mp3', name: '温柔回忆', description: '柔和感伤的钢琴旋律' }
    ]
  })
}

test('scenarioCues resolves semantic SE cues, curated effects, and Virtual Singer models', () => {
  assert.ok(scenarioCues.CURATED_SCENARIO_SES.length >= 20)
  assert.equal(scenarioCues.resolveScenarioSe('se00034_b.mp3')?.file, 'se00034_b.mp3')
  assert.equal(scenarioCues.resolveScenarioSe('回忆闪烁')?.file, 'se00053_b.mp3')
  assert.ok(scenarioCues.resolveScenarioSe('收到短信通知')?.file)
  assert.ok(scenarioCues.resolveScenarioSe('门打开的声音')?.file)
  assert.ok(scenarioCues.sePromptList().includes('se00053_b.mp3'))

  assert.equal(scenarioCues.normalizeScenarioEffectName('樱花飘落'), 'sakura')
  assert.equal(scenarioCues.normalizeScenarioEffectName('rain'), 'rain')
  assert.equal(scenarioCues.isVirtualSingerModel({ id: 21, name: '初音未来' }), true)
  assert.equal(scenarioCues.isVirtualSingerModel({ id: 16, name: '神代类' }), false)
})

test('corpusExamples and personas enforce Wonderhoy and 宁宁号 terminology', () => {
  const wxsSample = corpusExamples.selectUnitFewShotExcerpts(
    [{ name: '凤笑梦' }, { name: '草薙宁宁' }],
    '奇幻舞台彩排'
  )
  assert.ok(wxsSample.includes('Wonderhoy') || wxsSample.includes('宁宁号'))
  assert.ok(!wxsSample.includes('Wonderhoi'))
  assert.ok(!wxsSample.includes('宁宁机器人'))

  assert.equal(
    personas.normalizePjskTerminology('大家一起 Wonderho～i！宁宁机器人也来！'),
    '大家一起 Wonderho～y！宁宁号也来！'
  )
  assert.equal(personas.normalizePjskTerminology('Wonderhoi!'), 'Wonderhoy!')
})

test('normalizeDirection preserves facial on short reactions and builds 2-beat Talk.actions', () => {
  const view = makeEnsembleView()
  const plan = staged.fallbackCastPlan(view, {
    scene: '天马司、凤笑梦、草薙宁宁、神代类在奇幻舞台群像彩排',
    personas: [],
    targetMinutes: 2
  })
  const dialogue = {
    title: '彩排风波',
    lines: [
      { id: 'l1', speaker: '司', content: '大家听我说！下一个动作一定要跟上灯光，不然观众看不到！' },
      { id: 'l2', speaker: '宁宁', content: '……嗯？' },
      { id: 'l3', speaker: '笑梦', content: '哇——！' },
      { id: 'l4', speaker: '类', content: '呵呵，先别急，我先把舞台升降台和烟花时序调好再说。' }
    ]
  }
  const direction = staged.normalizeDirection(
    {
      background: 'bg_stage.jpg',
      lines: [
        {
          id: 'l1',
          motion: 'w-normal-glad01',
          facial: 'face_smile_01',
          at2: 0.55,
          motion2: 'w-normal-pose01',
          facial2: 'face_surprise_01'
        },
        { id: 'l2', facial: 'face_trouble_01' },
        { id: 'l3', facial: 'face_sparkling_01' },
        { id: 'l4', motion: 'w-normal-think01', facial: 'face_smug_01' }
      ]
    },
    view,
    plan,
    dialogue
  )

  const l1 = direction.lines.find((l) => l.id === 'l1')
  const l2 = direction.lines.find((l) => l.id === 'l2')
  const l3 = direction.lines.find((l) => l.id === 'l3')
  assert.equal(l1.beats.length, 2, 'l1 should keep 2-beat micro-turn actions')
  assert.equal(l1.beats[0].at, 0)
  assert.equal(l1.beats[1].at, 0.55)
  assert.equal(l2.facial, 'face_trouble_01', 'short reaction line l2 must NOT lose facial')
  assert.equal(l3.facial, 'face_sparkling_01', 'short reaction line l3 must NOT lose facial')
})

test('5-stage director compiles 4-cast ThreeMode, multi-scene transitions, hologram, silence cut, and passes officialLinter', () => {
  const view = makeEnsembleView()
  const plan = staged.normalizeCastPlan(
    {
      title: '仙境舞台的约定',
      event: 'WxS 成员讨论新演出，短暂回忆后重回世界舞台',
      background: 'bg_stage.jpg',
      cast: [
        { modelId: 13, name: '司', role: '领队' },
        { modelId: 14, name: '笑梦', role: '氛围' },
        { modelId: 15, name: '宁宁', role: '冷静吐槽' },
        { modelId: 21, name: 'MIKU', role: '虚拟歌手指引' }
      ],
      scenes: [
        { id: 's1', location: 'bg_stage.jpg', time: 'day', transition: 'black', summary: '开场讨论与试演' },
        { id: 's2', location: 'bg_past_park.jpg', time: 'day', transition: 'flashback', isFlashback: true, summary: '短暂回忆过去' },
        { id: 's3', location: 'bg_sekai_wxs.jpg', time: 'day', transition: 'sekai', isSekai: true, summary: '进入世界与全息MIKU会合' }
      ]
    },
    view,
    'WxS 群像新演出'
  )

  const dialogue = staged.normalizeDialogue(
    {
      title: '仙境舞台的约定',
      lines: [
        { id: 'l1', speaker: '司', content: '好！今天的新演出编排，就从这里正式开始吧！' },
        { id: 'l2', speaker: '笑梦', content: 'Wonderhoy！大家今天也要元气满满地冲呀！' },
        { id: 'l3', speaker: '宁宁', content: '……先等等，宁宁号的推进器还没校准完呢。' },
        { id: 'l4', speaker: '司', content: '唔……说起来，以前在公园练习时也出过类似的小意外。', closeWindowAfter: true },
        { id: 'l5', speaker: '宁宁', content: '那个时候你差点把道具树撞倒，结果还强撑着摆姿势。' },
        { id: 'l6', speaker: '笑梦', content: '哈哈，不过正是因为那次，我们才想到更好的站位！', pauseBefore: 1.0 },
        { id: 'l7', speaker: 'MIKU', content: '欢迎来到仙境世界，我一直在等你们呢！' },
        { id: 'l8', speaker: '司', content: 'MIKU！正需要你帮我们看看终幕的配合效果！' }
      ]
    },
    plan
  )

  const staging = staged.normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_stage.jpg',
          ambient: 'normal',
          telop: '两天后 舞台',
          placeInfo: '凤凰仙境 奇妙舞台',
          bgm: 'bgm00003.mp3',
          activeCast: [13, 14, 15],
          scenarioEffect: 'sakura'
        },
        {
          id: 's2',
          fromLineId: 'l5',
          background: 'bg_past_park.jpg',
          ambient: 'normal',
          transitionIn: 'flashback',
          isFlashback: true,
          bgm: 'bgm00010.mp3',
          activeCast: [13, 15]
        },
        {
          id: 's3',
          fromLineId: 'l7',
          background: 'bg_sekai_wxs.jpg',
          ambient: 'normal',
          transitionIn: 'sekai',
          isSekai: true,
          bgm: 'bgm00003.mp3',
          activeCast: [13, 14, 21],
          hologramCast: [21]
        }
      ],
      events: [
        { lineId: 'l2', move: { speaker: '笑梦', kind: 'stepCloser', offset: 90 }, characterShake: { speaker: '宁宁', axis: 'X' } },
        { lineId: 'l3', silentReaction: { speaker: '宁宁', motion: 'w-normal-sigh01', facial: 'face_trouble_01' }, bgmCut: { action: 'stop' } },
        { lineId: 'l5', se: 'se00053_b.mp3' },
        { lineId: 'l8', camera: { kind: 'zoomIn', scale: 1.15, durationMs: 400 } }
      ]
    },
    view,
    plan,
    dialogue
  )

  const direction = staged.normalizeDirection(
    {
      background: 'bg_stage.jpg',
      lines: [
        { id: 'l1', motion: 'w-normal-nod01', facial: 'face_smile_01' },
        { id: 'l2', motion: 'w-normal-glad01', facial: 'face_sparkling_01', at2: 0.5, motion2: 'w-normal-greeting01' },
        { id: 'l3', facial: 'face_trouble_01' },
        { id: 'l4', motion: 'w-normal-nod01', facial: 'face_normal_01' },
        { id: 'l5', motion: 'w-normal-sigh01', facial: 'face_trouble_01' },
        { id: 'l6', motion: 'w-normal-glad01', facial: 'face_smile_01' },
        { id: 'l7', facial: 'face_smile_01' },
        { id: 'l8', motion: 'w-normal-pose01', facial: 'face_surprise_01' }
      ]
    },
    view,
    plan,
    dialogue
  )

  const rawStory = staged.composeStory(view, plan, dialogue, direction, staging)
  const { story } = validate.validateAndFixStory(rawStory, view)
  const report = linter.lintOfficialStory(story, view)

  assert.equal(report.passed, true, `officialLinter issues: ${report.issues.join('; ')}`)
  assert.ok(report.metrics.talkZeroDelayShare >= 0.85)
  assert.equal(report.metrics.slow100SlideCount, 0)
  assert.equal(report.metrics.appearMotionClashCount, 0)
  assert.equal(report.metrics.stageViolationCount, 0)
  assert.equal(report.metrics.unclosedEffects.length, 0)
  assert.equal(report.metrics.inPlaceAppearShare, 1)

  const types = new Set(story.snippets.map((s) => s.type))
  assert.ok(story.snippets.some((s) => s.type === 'ChangeLayoutMode' && s.data.mode === 'Three'))
  assert.ok(types.has('Telop'))
  assert.ok(types.has('PlaceInfo'))
  assert.ok(types.has('PlayScenarioEffect') && types.has('StopScenarioEffect'))
  assert.ok(types.has('FlashbackIn') && types.has('FlashbackOut'))
  assert.ok(types.has('SekaiOut') && types.has('SekaiIn'))
  assert.ok(types.has('Move'))
  assert.ok(types.has('CharacterShake'))
  assert.ok(types.has('Motion'))
  assert.ok(types.has('PlaySe'))
  assert.ok(types.has('CameraZoom'))
  assert.ok(story.snippets.some((s) => s.type === 'ChangeBgm' && s.data.stop === true))
  assert.ok(
    story.snippets.some((s) => s.type === 'AttachCharacterShader' && s.data.shader === 'hologram')
  )
  assert.ok(
    story.snippets.some((s) => s.type === 'AttachCharacterShader' && s.data.shader === 'none'),
    'hologram shader must cleanly reset to none before exit'
  )
})

test('officialLinter flags and enforces invariants on malformed snippets', () => {
  const view = makeEnsembleView()
  const badStory = {
    models: [
      { id: 13, model: '13tsukasa_normal/13tsukasa_normal.model3.json', normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_stage.jpg' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, progressBehavior: 'Now', delay: 0, data: { mode: 'Normal' } },
      { type: 'ChangeBackgroundImage', wait: false, progressBehavior: 'Now', delay: 0, data: { imageId: 1 } },
      {
        type: 'LayoutAppear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: 13, from: { side: 'Center', offset: 0 }, to: { side: 'Center', offset: 0 }, motion: 'w-normal-nod01', facial: 'face_smile_01' }
      },
      {
        type: 'AttachCharacterShader',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: 13, shader: 'hologram' }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0.1,
        data: {
          speaker: '司',
          content: '测试台词第一句。',
          ttsText: '',
          modelId: 13,
          actions: [{ at: 0, modelId: 13, motion: 'w-normal-glad01', facial: 'face_smile_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0.1,
        data: {
          speaker: '司',
          content: '测试台词第二句。',
          ttsText: '',
          modelId: 13
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0.1,
        data: {
          speaker: '司',
          content: '测试台词第三句。',
          ttsText: '',
          modelId: 13
        }
      },
      { type: 'SideFade', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { mode: 'Out', direction: 'Left', duration: 400 } },
      { type: 'FlashbackIn', wait: false, progressBehavior: 'Now', delay: 0, data: { duration: 100 } },
      { type: 'LayoutClear', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { modelId: 13, from: { side: 'Center', offset: 0 }, to: { side: 'Center', offset: 0 } } }
    ]
  }

  const before = linter.lintOfficialStory(badStory, view)
  assert.equal(before.passed, false)
  assert.ok(before.metrics.talkZeroDelayShare < 0.85)
  assert.ok(before.metrics.appearMotionClashCount >= 1)
  assert.ok(before.metrics.missingWindowCloseBeforeTransitionCount >= 1)
  assert.ok(before.metrics.unclosedEffects.length >= 2)

  const warnings = []
  const after = linter.enforceOfficialStoryInvariants(badStory, view, (w) => warnings.push(w))
  assert.ok(after.metrics.talkZeroDelayShare >= 0.85, 'mechanical 0.1s Talk.delay repaired')
  assert.equal(after.metrics.appearMotionClashCount, 0, '<0.4s appear-talk motion clash repaired')
  assert.equal(after.metrics.missingWindowCloseBeforeTransitionCount, 0, 'closeWindowOnFinish repaired before SideFade')
  assert.ok(
    badStory.snippets.some((s) => s.type === 'AttachCharacterShader' && s.data.shader === 'none'),
    'hologram shader auto-closed before LayoutClear'
  )
  assert.ok(
    badStory.snippets.some((s) => s.type === 'FlashbackOut'),
    'unclosed FlashbackIn auto-closed'
  )
})

test('stage LayoutAppear uses calm entrance motion instead of alphabetically-first blushed cue', () => {
  const catalog = {
    format: 'msst.cloud-catalog/1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    region: 'jp',
    models: [
      {
        id: '20mizuki_normal',
        characterId: 20,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-adult-blushed01', 'w-normal-default01', 'w-normal-nod01'],
        facials: ['face_normal_01', 'face_smile_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: '19ena_normal',
        characterId: 19,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal.model3.json',
        motions: ['w-adult-blushed01', 'w-normal-default01', 'w-normal-tilthead01'],
        facials: ['face_normal_01', 'face_smile_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    backgrounds: [{ id: 'bg1', name: '家庭餐厅', file: 'bg_restaurant.jpg' }],
    bgm: [{ id: 'bgm00001', title: '日常', file: 'bgm00001.mp3' }],
    se: [{ id: 'se00001_b', file: 'se00001_b.mp3', description: '轻响' }]
  }
  const view = new promptMod.CatalogView(catalog, {
    background: 'bg_restaurant.jpg',
    cast: [
      { id: 1, model: '20mizuki_normal/20mizuki_normal.model3.json', characterId: 20, name: '晓山瑞希' },
      { id: 2, model: '19ena_normal/19ena_normal.model3.json', characterId: 19, name: '东云绘名' }
    ]
  })
  const plan = staged.normalizeCastPlan(
    {
      title: '入口测试',
      background: 'bg_restaurant.jpg',
      cast: [
        { modelId: 1, name: '瑞希', role: 'A' },
        { modelId: 2, name: '绘名', role: 'B' }
      ],
      scenes: [{ id: 's1', location: 'bg_restaurant.jpg', time: 'day', transition: 'black', summary: '开场' }]
    },
    view,
    '两人开场'
  )
  const dialogue = staged.normalizeDialogue(
    {
      title: '入口测试',
      lines: [
        { id: 'l1', speaker: '瑞希', content: '这里先讨论一下。' },
        { id: 'l2', speaker: '绘名', content: '好，那我们开始。' }
      ]
    },
    plan
  )
  const staging = staged.normalizeStaging(
    {
      scenes: [{ id: 's1', fromLineId: 'l1', background: 'bg_restaurant.jpg', ambient: 'normal', activeCast: [1, 2], placements: [{ modelId: 1, side: 'Left' }, { modelId: 2, side: 'Right' }] }]
    },
    view,
    plan,
    dialogue
  )
  const direction = staged.normalizeDirection({ actions: [{ id: 'l1' }, { id: 'l2' }] }, view, plan, dialogue)
  const story = staged.composeStory(view, plan, dialogue, direction, staging)
  const appears = story.snippets.filter((s) => s.type === 'LayoutAppear')
  assert.equal(appears.length, 2)
  assert.equal(appears[0].data.motion, 'w-normal-nod01')
  assert.equal(appears[1].data.motion, 'w-normal-tilthead01')
  assert.ok(appears.every((s) => !/blushed/.test(s.data.motion)))
})
