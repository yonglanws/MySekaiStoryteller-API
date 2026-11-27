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
      {
        id: 'l1',
        speaker: '司',
        content: '大家听我说！下一个动作一定要跟上灯光，不然观众看不到！'
      },
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

test('5-stage director compiles 4-cast Normal mode (<=2 on stage with overlapping crossfades), multi-scene transitions, hologram, silence cut, and passes officialLinter', () => {
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
        {
          id: 's1',
          location: 'bg_stage.jpg',
          time: 'day',
          transition: 'black',
          summary: '开场讨论与试演'
        },
        {
          id: 's2',
          location: 'bg_past_park.jpg',
          time: 'day',
          transition: 'flashback',
          isFlashback: true,
          summary: '短暂回忆过去'
        },
        {
          id: 's3',
          location: 'bg_sekai_wxs.jpg',
          time: 'day',
          transition: 'sekai',
          isSekai: true,
          summary: '进入世界与全息MIKU会合'
        }
      ]
    },
    view,
    { scene: 'WxS 群像新演出', personas: [] }
  )

  const dialogue = staged.normalizeDialogue(
    {
      title: '仙境舞台的约定',
      lines: [
        { id: 'l1', speaker: '司', content: '好！今天的新演出编排，就从这里正式开始吧！' },
        { id: 'l2', speaker: '笑梦', content: 'Wonderhoy！大家今天也要元气满满地冲呀！' },
        { id: 'l3', speaker: '宁宁', content: '……先等等，宁宁号的推进器还没校准完呢。' },
        {
          id: 'l4',
          speaker: '司',
          content: '唔……说起来，以前在公园练习时也出过类似的小意外。',
          closeWindowAfter: true
        },
        { id: 'l5', speaker: '宁宁', content: '那个时候你差点把道具树撞倒，结果还强撑着摆姿势。' },
        {
          id: 'l6',
          speaker: '笑梦',
          content: '哈哈，不过正是因为那次，我们才想到更好的站位！',
          pauseBefore: 1.0
        },
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
        {
          lineId: 'l2',
          move: { speaker: '笑梦', kind: 'stepCloser', offset: 90 },
          characterShake: { speaker: '宁宁', axis: 'X' }
        },
        {
          lineId: 'l3',
          silentReaction: { speaker: '宁宁', motion: 'w-normal-sigh01', facial: 'face_trouble_01' },
          bgmCut: { action: 'stop' }
        },
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
        {
          id: 'l2',
          motion: 'w-normal-glad01',
          facial: 'face_sparkling_01',
          at2: 0.5,
          motion2: 'w-normal-greeting01'
        },
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
  assert.ok(story.snippets.some((s) => s.type === 'ChangeLayoutMode' && s.data.mode === 'Normal'))
  assert.ok(!story.snippets.some((s) => s.type === 'ChangeLayoutMode' && s.data.mode === 'Three'))

  // Assert <= 2 on-stage characters at all times & clean LayoutClear -> LayoutAppear stage transitions
  const onStage = new Set()
  let maxOnStage = 0
  let clearToAppearTransitions = 0
  for (let i = 0; i < story.snippets.length; i++) {
    const s = story.snippets[i]
    if (s.type === 'LayoutAppear') {
      onStage.add(s.data.modelId)
      maxOnStage = Math.max(maxOnStage, onStage.size)
      if (i > 0 && story.snippets[i - 1].type === 'LayoutClear') {
        clearToAppearTransitions += 1
      }
    } else if (s.type === 'LayoutClear') {
      onStage.delete(s.data.modelId)
    }
  }
  assert.ok(maxOnStage <= 2, `Expected max 2 on-stage characters in Normal mode, got ${maxOnStage}`)
  assert.ok(
    clearToAppearTransitions >= 1,
    'Expected at least 1 LayoutClear -> LayoutAppear stage transition'
  )

  assert.ok(types.has('Telop'))
  assert.ok(types.has('PlaceInfo'))
  assert.ok(types.has('PlayScenarioEffect') && types.has('StopScenarioEffect'))
  assert.ok(types.has('FlashbackIn') && types.has('FlashbackOut'))
  assert.ok(types.has('SekaiOut') && types.has('SekaiIn'))
  // 横向 Move 滑动已禁止，切镜统一由原地 LayoutClear -> LayoutAppear 渐变完成
  assert.ok(!types.has('Move'))
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

test('officialLinter rejects ThreeMode and keeps Normal-mode stage bounds', () => {
  const view = makeEnsembleView()
  const threeStory = {
    models: [
      {
        id: 13,
        model: '13tsukasa_normal/13tsukasa_normal.model3.json',
        normal_scale: 2.1,
        small_scale: 1.8,
        anchor: 0.5
      },
      {
        id: 14,
        model: '14emu_normal/14emu_normal.model3.json',
        normal_scale: 2.1,
        small_scale: 1.8,
        anchor: 0.5
      },
      {
        id: 15,
        model: '15nene_normal/15nene_normal.model3.json',
        normal_scale: 2.1,
        small_scale: 1.8,
        anchor: 0.5
      }
    ],
    images: [{ id: 1, image: 'bg_stage.jpg' }],
    snippets: [
      {
        type: 'ChangeLayoutMode',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { mode: 'Three' }
      },
      {
        type: 'ChangeBackgroundImage',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { imageId: 1 }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: 13, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 } }
      },
      {
        type: 'LayoutAppear',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: {
          modelId: 14,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 }
        }
      },
      {
        type: 'LayoutAppear',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: 15, from: { side: 'Right', offset: 0 }, to: { side: 'Right', offset: 0 } }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { speaker: '司', content: '测试。', modelId: 13, closeWindowOnFinish: true }
      }
    ]
  }
  const report = linter.lintOfficialStory(threeStory, view)
  assert.equal(report.passed, false)
  assert.ok(report.metrics.stageViolationCount >= 1)
})

test('officialLinter flags and enforces invariants on malformed snippets', () => {
  const view = makeEnsembleView()
  const badStory = {
    models: [
      {
        id: 13,
        model: '13tsukasa_normal/13tsukasa_normal.model3.json',
        normal_scale: 2.1,
        small_scale: 1.8,
        anchor: 0.5
      }
    ],
    images: [{ id: 1, image: 'bg_stage.jpg' }],
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
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { imageId: 1 }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          modelId: 13,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          motion: 'w-normal-nod01',
          facial: 'face_smile_01'
        }
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
      {
        type: 'SideFade',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { mode: 'Out', direction: 'Left', duration: 400 }
      },
      {
        type: 'FlashbackIn',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { duration: 100 }
      },
      {
        type: 'LayoutClear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          modelId: 13,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 }
        }
      }
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
  assert.equal(
    after.metrics.missingWindowCloseBeforeTransitionCount,
    0,
    'closeWindowOnFinish repaired before SideFade'
  )
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
      {
        id: 1,
        model: '20mizuki_normal/20mizuki_normal.model3.json',
        characterId: 20,
        name: '晓山瑞希'
      },
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
      scenes: [
        {
          id: 's1',
          location: 'bg_restaurant.jpg',
          time: 'day',
          transition: 'black',
          summary: '开场'
        }
      ]
    },
    view,
    { scene: '两人开场', personas: [] }
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
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_restaurant.jpg',
          ambient: 'normal',
          activeCast: [1, 2],
          placements: [
            { modelId: 1, side: 'Left' },
            { modelId: 2, side: 'Right' }
          ]
        }
      ]
    },
    view,
    plan,
    dialogue
  )
  const direction = staged.normalizeDirection(
    { actions: [{ id: 'l1' }, { id: 'l2' }] },
    view,
    plan,
    dialogue
  )
  const story = staged.composeStory(view, plan, dialogue, direction, staging)
  const appears = story.snippets.filter((s) => s.type === 'LayoutAppear')
  assert.equal(appears.length, 2)
  assert.equal(appears[0].data.motion, 'w-normal-nod01')
  assert.equal(appears[1].data.motion, 'w-normal-tilthead01')
  assert.ok(appears.every((s) => !/blushed/.test(s.data.motion)))
})

test('Wave 5: normalizeDirection preserves facial during body-motion pruning and breaks stuck face_normal_01', () => {
  const { CatalogView } = promptMod
  const view = new CatalogView({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-tilthead01', 'w-normal-glad01'],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_smile_02',
          'face_closeeye_01',
          'face_serious_01',
          'face_trouble_01',
          'face_smallmouth_01',
          'face_lookaway_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-sigh01'],
        facials: [
          'face_normal_01',
          'face_angry_01',
          'face_sad_01',
          'face_trouble_01',
          'face_worry_01',
          'face_serious_01',
          'face_closeeye_01',
          'face_smile_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_rooftop.jpg'],
    imageDetails: [
      {
        file: 'bg_rooftop.jpg',
        id: 'bg_a002801',
        name: '天台',
        timeOfDay: '白天',
        indoor: '室外',
        description: '校园·白天·室外'
      }
    ],
    voices: [],
    bgm: ['bgm00003.mp3'],
    bgmDetails: [{ file: 'bgm00003.mp3', name: '日常', description: '日常旋律' }]
  })

  const curated = view.promptFacials(view.modelById(1))
  assert.ok(curated.length <= 28)
  assert.ok(curated.includes('face_smile_02'))
  assert.ok(curated.includes('face_lookaway_01'))
  assert.ok(curated.includes('face_smallmouth_01'))

  const plan = staged.fallbackCastPlan(view, {
    scene: '放学后天台对话',
    personas: [],
    targetMinutes: 2
  })
  const lines = Array.from({ length: 12 }, (_, idx) => ({
    id: `l${idx + 1}`,
    speaker: idx % 2 === 0 ? '瑞希' : '绘名',
    content: idx === 0 ? '呀吼——，终于等到你了♪' : `第${idx + 1}句认真聊聊吧。`,
    emotion: '平静'
  }))
  const dialogue = { title: '天台对话', lines }

  // 100% lines have motion + facial -> body-motion budget trims 1 motion, NEVER facial
  const rawDir = {
    background: 'bg_rooftop.jpg',
    lines: lines.map((l) => ({
      id: l.id,
      motion: l.speaker === '瑞希' ? 'w-normal-nod01' : 'w-normal-sigh01',
      facial: 'face_normal_01'
    }))
  }
  const normalized = staged.normalizeDirection(rawDir, view, plan, dialogue)
  assert.equal(
    normalized.lines.length,
    12,
    'all 12 lines must retain facial even when excess body motion is pruned'
  )
  assert.ok(
    normalized.lines.every((l) => Boolean(l.facial)),
    'normalizeDirection must never delete facial during motion budget pruning'
  )

  const dirPrompt = staged.buildDirectionPrompt(view, plan, dialogue, {
    scene: '天台对话',
    personas: [],
    targetMinutes: 2
  })
  assert.ok(!dirPrompt.user.includes('平静用 normal / smallmouth / closeeye'))

  // composeStory diversifies consecutive face_normal_01 on the same speaker
  const story = staged.composeStory(view, plan, dialogue, normalized)
  const mizukiFacials = story.snippets
    .filter((s) => s.type === 'Talk' && s.data.modelId === 1)
    .flatMap((s) => (s.data.actions ?? []).filter((a) => a.modelId === 1).map((a) => a.facial))
    .filter(Boolean)
  assert.ok(
    mizukiFacials.some((f) => f !== 'face_normal_01'),
    `expected varied facials beyond face_normal_01, got ${mizukiFacials.join(', ')}`
  )
})

test('Wave 5: scolded listener never mirrors speaker angry/smile on reaction', () => {
  const { CatalogView } = promptMod
  const view = new CatalogView({
    models: [
      {
        id: 1,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-sigh01'],
        facials: [
          'face_smile_01',
          'face_angry_01',
          'face_angry_02',
          'face_serious_01',
          'face_sad_01',
          'face_trouble_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 2,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-sigh01', 'w-normal-tilthead01'],
        facials: [
          'face_smile_01',
          'face_angry_01',
          'face_angry_02',
          'face_trouble_01',
          'face_worry_01',
          'face_sad_01',
          'face_closeeye_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['bg_rooftop.jpg'],
    imageDetails: [
      {
        file: 'bg_rooftop.jpg',
        name: '天台',
        timeOfDay: '白天',
        indoor: '室外',
        description: '天台'
      }
    ],
    voices: [],
    bgm: ['bgm00003.mp3'],
    bgmDetails: [{ file: 'bgm00003.mp3', name: '日常', description: '日常' }]
  })

  const plan = staged.fallbackCastPlan(view, {
    scene: '绘名生气地质问瑞希',
    personas: [],
    targetMinutes: 2
  })
  const lines = Array.from({ length: 16 }, (_, idx) => ({
    id: `l${idx + 1}`,
    speaker: idx < 12 ? '绘名' : '瑞希',
    content: idx < 12 ? '不要再擅自替我决定！别再把我推开了！' : '……抱歉，绘名。',
    emotion: idx < 12 ? '生气' : '伤心'
  }))
  const dialogue = { title: '冲突', lines }
  const direction = staged.normalizeDirection(
    {
      background: 'bg_rooftop.jpg',
      lines: lines.map((l) => ({
        id: l.id,
        motion: l.speaker === '绘名' ? 'w-normal-nod01' : 'w-normal-sigh01',
        facial: l.speaker === '绘名' ? 'face_angry_01' : 'face_sad_01'
      }))
    },
    view,
    plan,
    dialogue
  )
  const story = staged.composeStory(view, plan, dialogue, direction)

  const mizukiReactionsWhileEnaScolds = []
  let seenEnaAngry = false
  for (const s of story.snippets) {
    if (s.type === 'Talk' && s.data.modelId === 1) {
      seenEnaAngry = true
      for (const act of s.data.actions ?? []) {
        if (act.modelId === 2 && act.facial) mizukiReactionsWhileEnaScolds.push(act.facial)
      }
    } else if (seenEnaAngry && s.type === 'Motion' && s.data.modelId === 2 && s.data.facial) {
      mizukiReactionsWhileEnaScolds.push(s.data.facial)
    }
  }
  assert.ok(mizukiReactionsWhileEnaScolds.length > 0, 'expected listener reactions during scolding')
  assert.ok(
    mizukiReactionsWhileEnaScolds.every((f) => !/angry|smile/i.test(f)),
    `scolded listener must react with trouble/worry/sad/closeeye, not angry/smile: ${mizukiReactionsWhileEnaScolds.join(', ')}`
  )
})

test('Wave 5: stabilizeEmotions preserves 2-line sad plea and cheerful ~♪ epilogue without quotas', () => {
  const dialogue = {
    title: '和解',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '今天天气不错呢。' },
      { id: 'l2', speaker: '绘名', content: '嗯，先坐下吧。' },
      { id: 'l3', speaker: '瑞希', content: '刚才的事，我其实一直在想。' },
      { id: 'l4', speaker: '绘名', content: '不要擅自替我决定！' },
      { id: 'l5', speaker: '绘名', content: '你总是这样装作没事！' },
      { id: 'l6', speaker: '绘名', content: '别再把我推开了，瑞希。' },
      { id: 'l7', speaker: '绘名', content: '拜托了……我想站在你这边。' },
      { id: 'l8', speaker: '瑞希', content: '…………' },
      { id: 'l9', speaker: '瑞希', content: '绘名，你果然很狡猾啊。' },
      { id: 'l10', speaker: '瑞希', content: '那张画，明天再一起重新画吧～♪' },
      { id: 'l11', speaker: '绘名', content: '嗯，一言为定～♪' },
      { id: 'l12', speaker: '瑞希', content: '走吧，回去画画喽！' }
    ]
  }
  const plan = new Map([
    ['l1', '平静'],
    ['l2', '平静'],
    ['l3', '平静'],
    ['l4', '生气'],
    ['l5', '生气'],
    ['l6', '伤心'],
    ['l7', '伤心'],
    ['l8', '伤心'],
    ['l9', '开心'],
    ['l10', '开心'],
    ['l11', '开心'],
    ['l12', '开心']
  ])
  const stable = staged.stabilizeEmotions(dialogue, plan, ['平静', '开心', '伤心', '生气'])
  assert.equal(stable.get('l6'), '伤心')
  assert.equal(stable.get('l7'), '伤心')
  assert.equal(stable.get('l10'), '开心')
  assert.equal(stable.get('l11'), '开心')
  assert.equal(stable.get('l12'), '开心')

  const prompt = staged.buildEmotionPrompt(
    { title: '和解', event: '天台谈心', logline: '', outline: [], cast: [], background: '' },
    dialogue,
    {
      scene: '天台谈心',
      personas: [],
      targetMinutes: 2,
      emotionLabels: ['平静', '开心', '伤心', '生气']
    }
  )
  assert.ok(!prompt.user.includes('至少 3 段、最多 6 段'))
  assert.ok(!prompt.user.includes('相邻段不能使用同一个标签'))
})

test('Wave 5: opening/mid-scene curtain fences, post-Talk WaitFinished cues, daytime ambient clamp, and punctuation ttsText', () => {
  const { CatalogView } = promptMod
  const view = new CatalogView({
    models: [
      {
        id: 1,
        name: '瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01'],
        facials: ['face_smile_01', 'face_normal_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2,
        name: '绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-tilthead01'],
        facials: ['face_normal_01', 'face_smile_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_a002801.jpg', 'bg_a000302.jpg'],
    imageDetails: [
      {
        file: 'bg_a002801.jpg',
        id: 'bg_a002801',
        name: '天台',
        timeOfDay: '白天',
        indoor: '室外',
        description: '校园·白天·室外'
      },
      {
        file: 'bg_a000302.jpg',
        id: 'bg_a000302',
        name: '神山高校 空教室',
        timeOfDay: '黄昏',
        indoor: '室内',
        description: '校园·黄昏·室内'
      }
    ],
    voices: [],
    bgm: ['bgm00003.mp3', 'bgm00006.mp3'],
    bgmDetails: [
      { file: 'bgm00003.mp3', name: '日常', description: '日常' },
      { file: 'bgm00006.mp3', name: '黄昏', description: '黄昏' }
    ],
    se: [{ id: 'se00004_b', file: 'se00004_b.mp3', description: '提示音' }]
  })

  const plan = staged.normalizeCastPlan(
    {
      title: '时序测试',
      background: 'bg_a002801.jpg',
      cast: [
        { modelId: 1, name: '瑞希', role: 'A' },
        { modelId: 2, name: '绘名', role: 'B' }
      ],
      scenes: [
        { id: 's1', location: 'bg_a002801.jpg', time: 'day', transition: 'black', summary: '白天' },
        {
          id: 's2',
          location: 'bg_a000302.jpg',
          time: 'evening',
          transition: 'black',
          summary: '黄昏'
        }
      ]
    },
    view,
    { scene: '天台到教室', personas: [] }
  )
  const dialogue = {
    title: '时序测试',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '先看下这里。' },
      { id: 'l2', speaker: '绘名', content: '…………', ttsText: '……' },
      { id: 'l3', speaker: '瑞希', content: '我们回教室吧。' }
    ]
  }
  const staging = staged.normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_a002801.jpg',
          ambient: 'evening',
          bgm: 'bgm00003.mp3',
          activeCast: [1, 2]
        },
        {
          id: 's2',
          fromLineId: 'l3',
          background: 'bg_a000302.jpg',
          ambient: 'evening',
          bgm: 'bgm00006.mp3',
          activeCast: [1, 2]
        }
      ],
      events: [
        {
          lineId: 'l2',
          se: { file: 'se00004_b.mp3', timing: 'before' },
          characterShake: { modelId: 2, axis: 'X' },
          camera: { kind: 'zoomIn', scale: 1.1 }
        }
      ]
    },
    view,
    plan,
    dialogue
  )
  assert.equal(
    staging.scenes[0].ambient,
    'normal',
    'daytime background must clamp evening ambient to normal'
  )
  assert.equal(staging.scenes[1].ambient, 'evening')

  const direction = staged.normalizeDirection(
    { background: 'bg_a002801.jpg', bgmStop: true, lines: [{ id: 'l1', facial: 'face_smile_01' }] },
    view,
    plan,
    dialogue
  )
  const rawStory = staged.composeStory(view, plan, dialogue, direction, staging)
  const { story } = validate.validateAndFixStory(rawStory, view)
  const snippets = story.snippets

  // Opening starts with instant BlackOut(0) before ChangeBackgroundImage(WaitFinished) -> BlackIn
  const firstBlackOutIdx = snippets.findIndex((s) => s.type === 'BlackOut')
  const firstBgIdx = snippets.findIndex((s) => s.type === 'ChangeBackgroundImage')
  const firstBlackInIdx = snippets.findIndex((s) => s.type === 'BlackIn')
  assert.ok(firstBlackOutIdx >= 0 && firstBlackOutIdx < firstBgIdx && firstBgIdx < firstBlackInIdx)
  assert.equal(snippets[firstBlackOutIdx].data.duration, 0)
  assert.equal(snippets[firstBgIdx].progressBehavior, 'WaitFinished')

  // Mid-scene curtain ChangeBackgroundImage fences LayoutClear before LayoutAppear
  const secondBgIdx = snippets.findIndex(
    (s, i) => i > firstBlackInIdx && s.type === 'ChangeBackgroundImage'
  )
  assert.ok(secondBgIdx > firstBlackInIdx)
  assert.equal(snippets[secondBgIdx].progressBehavior, 'WaitFinished')
  const appearAfterSecondBg = snippets.findIndex(
    (s, i) => i > secondBgIdx && s.type === 'LayoutAppear'
  )
  assert.equal(snippets[appearAfterSecondBg].progressBehavior, 'WaitFinished')

  // Pre-line PlaySe, CharacterShake, and ChangeBgmWaitFinished fence after preceding Talk
  const l2TalkIdx = snippets.findIndex((s) => s.type === 'Talk' && s.data.content === '…………')
  const playSeBeforeL2 = snippets.find((s, i) => i < l2TalkIdx && s.type === 'PlaySe')
  const shakeBeforeL2 = snippets.find((s, i) => i < l2TalkIdx && s.type === 'CharacterShake')
  assert.equal(playSeBeforeL2.progressBehavior, 'WaitFinished')
  assert.equal(shakeBeforeL2.progressBehavior, 'WaitFinished')
  const camAfterL2 = snippets.find((s, i) => i > l2TalkIdx && s.type === 'CameraZoom')
  assert.ok(camAfterL2 && camAfterL2.progressBehavior === 'Now')
  const bgmStop = snippets.find((s) => s.type === 'ChangeBgm' && s.data.stop === true)
  assert.equal(bgmStop.progressBehavior, 'WaitFinished')

  // Punctuation-only Talk clears punctuation-only ttsText
  assert.equal(snippets[l2TalkIdx].data.ttsText, '')
})

test('Wave 5 regression: post-silent and tense-preceded 平静 beats never fall back to face_smile_*', () => {
  const { CatalogView } = promptMod
  const view = new CatalogView({
    models: [
      {
        id: 2321,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: [
          'w-normal01-default',
          'w-normal01-nod',
          'w-happy14-lookaway',
          'w-normal17-fidget'
        ],
        facials: [
          'face_smile_01',
          'face_smile_02',
          'face_normal_01',
          'face_closeeye_01',
          'face_serious_01',
          'face_trouble_01',
          'face_trouble_02',
          'face_worry_01',
          'face_sad_01',
          'face_smallmouth_01'
        ],
        defaultMotion: 'w-normal01-default',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2305,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal.model3.json',
        motions: ['w-normal01-default', 'w-normal01-nod', 'w-normal16-angry', 'w-normal03-forward'],
        facials: [
          'face_smile_01',
          'face_normal_01',
          'face_angry_01',
          'face_serious_01',
          'face_serious_02',
          'face_sad_01',
          'face_trouble_01',
          'face_closeeye_01'
        ],
        defaultMotion: 'w-normal01-default',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_rooftop.jpg', 'bg_classroom.jpg'],
    imageDetails: [
      {
        file: 'bg_rooftop.jpg',
        name: '天台',
        timeOfDay: '白天',
        indoor: '室外',
        description: '天台'
      },
      {
        file: 'bg_classroom.jpg',
        name: '教室',
        timeOfDay: '夜晚',
        indoor: '室内',
        description: '夜晚教室'
      }
    ],
    voices: [],
    bgm: ['bgm00018.mp3', 'bgm00027.mp3'],
    bgmDetails: [
      { file: 'bgm00018.mp3', name: '日常', description: '日常' },
      { file: 'bgm00027.mp3', name: '对峙', description: '紧张对峙' }
    ]
  })

  const plan = staged.fallbackCastPlan(view, {
    scene: '绘名生气地质问瑞希，瑞希沉默后进入回忆，之后重归于好',
    personas: [],
    targetMinutes: 2
  })
  const lines = [
    { id: 'l1', speaker: '瑞希', content: '今天天气真不错呀♪', emotion: '开心', sceneId: 's1' },
    {
      id: 'l2',
      speaker: '绘名',
      content: '别在那里笑着敷衍我了！',
      emotion: '生气',
      sceneId: 's1'
    },
    { id: 'l3', speaker: '绘名', content: '你到底在顾虑什么？', emotion: '生气', sceneId: 's1' },
    { id: 'l4', speaker: '瑞希', content: '（……糟糕。）', emotion: '平静', sceneId: 's1' },
    {
      id: 'l5',
      speaker: '瑞希',
      content: '…………',
      emotion: '平静',
      sceneId: 's1',
      closeWindowAfter: true
    },
    { id: 'l6', speaker: '绘名', content: '——呐，瑞希。', emotion: '平静', sceneId: 's2' },
    { id: 'l7', speaker: '瑞希', content: '……抱歉，绘名。', emotion: '伤心', sceneId: 's2' },
    {
      id: 'l8',
      speaker: '瑞希',
      content: '总觉得自己快跟不上大家了。',
      emotion: '伤心',
      sceneId: 's2'
    },
    { id: 'l9', speaker: '绘名', content: '笨蛋。', emotion: '平静', sceneId: 's3' },
    {
      id: 'l10',
      speaker: '瑞希',
      content: '以后也会一起画下去哦♪',
      emotion: '开心',
      sceneId: 's3'
    },
    { id: 'l11', speaker: '绘名', content: '一言为定。', emotion: '开心', sceneId: 's3' },
    { id: 'l12', speaker: '瑞希', content: '那我们走吧～♪', emotion: '开心', sceneId: 's3' }
  ]
  const dialogue = { title: '天台对峙', lines }
  const staging = staged.normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_rooftop.jpg',
          ambient: 'normal',
          activeCast: [2321, 2305]
        },
        {
          id: 's2',
          fromLineId: 'l6',
          background: 'bg_classroom.jpg',
          ambient: 'night',
          transitionIn: 'flashback',
          isFlashback: true,
          activeCast: [2321, 2305]
        },
        {
          id: 's3',
          fromLineId: 'l9',
          background: 'bg_rooftop.jpg',
          ambient: 'normal',
          transitionIn: 'sideFade',
          activeCast: [2321, 2305]
        }
      ],
      events: [{ lineId: 'l5', closeWindowAfter: true, silentReaction: { modelId: 2321 } }]
    },
    view,
    plan,
    dialogue
  )
  const direction = staged.normalizeDirection(
    {
      background: 'bg_rooftop.jpg',
      lines: [
        { id: 'l1', facial: 'face_smile_01' },
        { id: 'l2', motion: 'w-normal16-angry', facial: 'face_angry_01' },
        { id: 'l3', motion: 'w-normal03-forward', facial: 'face_serious_02' },
        // Deliberately test both LLM slip (face_smile_01 on silent/tense line) and silentMotion fallback
        { id: 'l4', facial: 'face_smile_01' },
        { id: 'l5', motion: 'w-happy14-lookaway', facial: 'face_closeeye_01', silentMotion: true },
        { id: 'l6', motion: 'w-normal01-nod', facial: 'face_serious_01' },
        { id: 'l7', facial: 'face_sad_01' },
        { id: 'l8', facial: 'face_worry_01' },
        { id: 'l9', facial: 'face_closeeye_01' },
        { id: 'l10', facial: 'face_smile_01' },
        { id: 'l11', facial: 'face_smile_01' },
        { id: 'l12', facial: 'face_smile_02' }
      ]
    },
    view,
    plan,
    dialogue
  )

  const story = staged.composeStory(view, plan, dialogue, direction, staging)
  const l4Idx = story.snippets.findIndex(
    (s) => s.type === 'Talk' && s.data.content === '（……糟糕。）'
  )
  const l5Idx = story.snippets.findIndex((s) => s.type === 'Talk' && s.data.content === '…………')
  assert.ok(l4Idx >= 0 && l5Idx > l4Idx)

  const l4Talk = story.snippets[l4Idx]
  const l4Facials = (l4Talk.data.actions ?? []).map((a) => a.facial).filter(Boolean)
  assert.ok(
    l4Facials.every((f) => !/smile|smug|wink|sparkling/i.test(f)),
    `tense-preceded line l4 must not use smile facial, got: ${l4Facials.join(', ')}`
  )

  const l5Talk = story.snippets[l5Idx]
  const l5Facials = (l5Talk.data.actions ?? []).map((a) => a.facial).filter(Boolean)
  assert.ok(
    l5Facials.every((f) => !/smile|smug|wink|sparkling/i.test(f)),
    `silent pause l5 must not use smile facial, got: ${l5Facials.join(', ')}`
  )

  const postSilentMotion = story.snippets[l5Idx + 1]
  assert.equal(postSilentMotion?.type, 'Motion', 'expected silent reaction Motion right after l5')
  assert.ok(
    !/smile|smug|wink|sparkling/i.test(postSilentMotion.data.facial || ''),
    `post-silent Motion [47] must NOT assign face_smile_* after tense beat, got: ${postSilentMotion.data.facial}`
  )

  // Genuine cheerful lines at opening & epilogue still preserve smile
  const l1Talk = story.snippets.find((s) => s.type === 'Talk' && s.data.content.includes('♪'))
  assert.equal(l1Talk.data.actions[0].facial, 'face_smile_01')
  const l10Talk = story.snippets.find(
    (s) => s.type === 'Talk' && s.data.content === '以后也会一起画下去哦♪'
  )
  assert.equal(l10Talk.data.actions[0].facial, 'face_smile_01')

  // Even when staging LLM explicitly emits face_smile_01 in silentReaction or direction listener,
  // post-silent & tense-preceded beats must suppress incongruous smiles.
  const explicitSmileStaging = staged.normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_rooftop.jpg',
          ambient: 'normal',
          activeCast: [2321, 2305]
        },
        {
          id: 's2',
          fromLineId: 'l6',
          background: 'bg_classroom.jpg',
          ambient: 'night',
          transitionIn: 'flashback',
          isFlashback: true,
          activeCast: [2321, 2305]
        },
        {
          id: 's3',
          fromLineId: 'l9',
          background: 'bg_rooftop.jpg',
          ambient: 'normal',
          transitionIn: 'sideFade',
          activeCast: [2321, 2305]
        }
      ],
      events: [
        {
          lineId: 'l5',
          closeWindowAfter: true,
          silentReaction: { modelId: 2321, motion: 'w-normal01-nod', facial: 'face_smile_01' }
        }
      ]
    },
    view,
    plan,
    dialogue
  )
  const explicitSmileDir = staged.normalizeDirection(
    {
      background: 'bg_rooftop.jpg',
      lines: [
        { id: 'l1', facial: 'face_smile_01' },
        { id: 'l2', motion: 'w-normal16-angry', facial: 'face_angry_01' },
        { id: 'l3', motion: 'w-normal03-forward', facial: 'face_serious_02' },
        {
          id: 'l4',
          facial: 'face_trouble_01',
          listener: { modelId: 2305, facial: 'face_smile_01' }
        },
        { id: 'l5', motion: 'w-happy14-lookaway', facial: 'face_closeeye_01', silentMotion: true }
      ]
    },
    view,
    plan,
    dialogue
  )
  const story2 = staged.composeStory(view, plan, dialogue, explicitSmileDir, explicitSmileStaging)
  const l4Talk2 = story2.snippets.find(
    (s) => s.type === 'Talk' && s.data.content === '（……糟糕。）'
  )
  const l4ListenerAct = l4Talk2.data.actions.find((a) => a.modelId === 2305)
  assert.ok(
    !l4ListenerAct?.facial || !/smile|smug|wink|sparkling/i.test(l4ListenerAct.facial),
    `listener facial on tense beat must not keep face_smile_01, got: ${l4ListenerAct?.facial}`
  )
  const l5Idx2 = story2.snippets.findIndex((s) => s.type === 'Talk' && s.data.content === '…………')
  const postSilent2 = story2.snippets[l5Idx2 + 1]
  assert.equal(postSilent2?.type, 'Motion')
  assert.ok(
    postSilent2.data.facial && !/smile|smug|wink|sparkling/i.test(postSilent2.data.facial),
    `explicit silentReaction.facial=face_smile_01 on silent/tense beat must be replaced, got: ${postSilent2.data.facial}`
  )
})
