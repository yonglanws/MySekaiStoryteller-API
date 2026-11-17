/**
 * pjsk-scenario 转换器的模型完整性回归。
 *
 * 官方剧本里存在只有台词、没有动作的说话者（观众、旁白、广播等）。
 * 这类 Talk 的 modelId 也必须进入 story.models，否则渲染端在预加载后
 * 解析片段时会报 "Model with id N not found"。整个导出流程此前无法在
 * 单元测试里发现这个问题，因为转换器只把“出现在动作/布局里的模型”
 * 记进了 usedModels。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const converter = path.join(here, 'pjsk-scenario.mjs')
const nodeRequire = createRequire(import.meta.url)

function loadStorySchema() {
  const file = path.join(root, 'src/common/types/Story.ts')
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file
  }).outputText
  const exports = {}
  const mod = { exports }
  vm.runInNewContext(
    `(function (exports, require, module) {\n${code}\n})`,
    { console, Math, Number, String, Boolean, Array, Object }
  )(exports, (spec) => nodeRequire(spec), mod)
  return mod.exports.StorySchema
}

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-scenario-'))
  try {
    return run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

test('talk-only speaker is declared in story.models', () => {
  withTempDir((dir) => {
    const scenario = {
      ScenarioId: 'synthetic_talk_only',
      AppearCharacters: [{ Character2dId: 296 }],
      FirstLayout: [],
      FirstBgm: 'bgm00000',
      FirstBackground: 'bg_test',
      FirstCharacterLayoutMode: 0,
      Snippets: [
        { Index: 0, Action: 1, ProgressBehavior: 1, ReferenceIndex: 0, Delay: 0 },
        { Index: 1, Action: 1, ProgressBehavior: 1, ReferenceIndex: 1, Delay: 0 }
      ],
      TalkData: [
        {
          WindowDisplayName: '观众',
          Body: 'わあ……！',
          TalkCharacters: [{ Character2dId: 296 }],
          Motions: []
        },
        {
          WindowDisplayName: '一歌',
          Body: 'ありがとう！',
          TalkCharacters: [{ Character2dId: 297 }],
          Motions: [
            {
              Character2dId: 297,
              MotionName: 'w-normal01-smile',
              FacialName: 'face_smile_01'
            }
          ]
        }
      ],
      LayoutData: [],
      SpecialEffectData: [],
      SoundData: [],
      ScenarioSnippetCharacterLayoutModes: []
    }
    const config = {
      title: 'synthetic',
      models: {
        1: {
          name: '观众',
          path: '01ichika_normal/01ichika_normal_3.0_f_t04/01ichika_normal.model3.json'
        },
        2: { name: '一歌', path: '02saki_normal/02saki_normal_3.0_f_t07/02saki_normal.model3.json' }
      },
      characterModels: {
        296: { default: 1 },
        297: { default: 2 }
      }
    }
    const scenarioPath = path.join(dir, 'scenario.json')
    const configPath = path.join(dir, 'models.json')
    const outPath = path.join(dir, 'story.json')
    writeJson(scenarioPath, scenario)
    writeJson(configPath, config)

    execFileSync(process.execPath, [
      converter,
      '--scenario',
      scenarioPath,
      '--config',
      configPath,
      '--out',
      outPath
    ])

    const story = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    const talks = story.snippets.filter((snippet) => snippet.type === 'Talk')
    assert.equal(talks.length, 2)
    assert.equal(talks[0].data.modelId, 1)
    assert.deepEqual(
      story.models.map((model) => model.id),
      [1, 2],
      'talk-only speaker model must be declared'
    )

    const declared = new Set(story.models.map((model) => model.id))
    for (const snippet of story.snippets) {
      if (Number.isFinite(snippet.data?.modelId)) {
        assert.ok(declared.has(snippet.data.modelId), `model ${snippet.data.modelId} missing`)
      }
    }
  })
})

test('pjsk-scenario maps all 45 SpecialEffect types, Layout depth/shake/over/under/costume, Talk flags, and Sound modes validly', () => {
  const StorySchema = loadStorySchema()
  withTempDir((dir) => {
    const scenario = {
      ScenarioId: 'synthetic_full_parity',
      FirstBackground: 'bg_first',
      FirstBgm: 'bgm00001',
      FirstCharacterLayoutMode: 3, // Three
      TalkData: [
        {
          WindowDisplayName: '一歌',
          Body: '第一句超长中文台词测试折行宽度是否已经升级到三十个汉字单位并且带有收窗标志。',
          TalkCharacters: [{ Character2dId: 1 }],
          Motions: [{ Character2dId: 1, MotionName: 'w-normal-nod01', FacialName: 'face_smile_01' }],
          WhenFinishCloseWindow: 1,
          RequirePlayEffect: 1
        }
      ],
      LayoutData: [
        // Appear at LeftOver with Depth=Back
        {
          Type: 2,
          Character2dId: 1,
          CostumeType: 'casual_summer',
          SideFrom: 2,
          SideFromOffsetX: 0,
          SideTo: 1,
          SideToOffsetX: 12,
          MoveSpeedType: 0,
          DepthType: 2,
          MotionName: 'w-normal-default',
          FacialName: 'face_normal'
        },
        // Move to RightOver
        {
          Type: 1,
          Character2dId: 1,
          CostumeType: 'casual_summer',
          SideFrom: 1,
          SideFromOffsetX: 0,
          SideTo: 6,
          SideToOffsetX: 0,
          MoveSpeedType: 1
        },
        // ShakeX + ShakeY
        { Type: 4, Character2dId: 1, MoveSpeedType: 0 },
        { Type: 5, Character2dId: 1, MoveSpeedType: 2 },
        // LayoutDepth Front + Clear from LeftUnder
        { Type: 6, Character2dId: 1, DepthType: 1 },
        { Type: 3, Character2dId: 1, SideFrom: 8, SideFromOffsetX: 0, SideTo: 10, SideToOffsetX: 0, MoveSpeedType: 0 }
      ],
      SpecialEffectData: [
        { EffectType: 0, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 1, Duration: 0.5, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 2, Duration: 0.5, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 3, Duration: 0.4, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 4, Duration: 0.4, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 5, Duration: 1.0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 6, Duration: 0.8, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 7, Duration: 0.3, StringVal: 'bg_second', StringValSub: '', IntVal: 0 },
        { EffectType: 8, Duration: 0, StringVal: 'Telop banner', StringValSub: '', IntVal: 0 },
        { EffectType: 9, Duration: 0.2, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 10, Duration: 0.2, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 11, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 12, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 13, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 14, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 15, Duration: 0.1, StringVal: 'ef_sakura', StringValSub: 'bundle_sakura', IntVal: 0 },
        { EffectType: 16, Duration: 0.1, StringVal: 'ef_sakura', StringValSub: '', IntVal: 0 },
        { EffectType: 17, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 18, Duration: 2.0, StringVal: 'School Rooftop', StringValSub: '', IntVal: 0 },
        { EffectType: 19, Duration: 1.5, StringVal: 'mv_intro.mp4', StringValSub: '', IntVal: 0 },
        { EffectType: 20, Duration: 0.7, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 21, Duration: 0.7, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 22, Duration: 0, StringVal: 'hologram', StringValSub: '', IntVal: 1 },
        { EffectType: 22, Duration: 0, StringVal: 'blur', StringValSub: '2.5', IntVal: 1 },
        { EffectType: 22, Duration: 0, StringVal: 'none', StringValSub: '', IntVal: 0 },
        { EffectType: 23, Duration: 0, StringVal: 'Stay/Leave', StringValSub: '', IntVal: 0 },
        { EffectType: 24, Duration: 2.0, StringVal: 'Quiet night.', StringValSub: 'vo_01', IntVal: 0 },
        { EffectType: 25, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 26, Duration: 0, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 27, Duration: 0.3, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 28, Duration: 0.3, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 29, Duration: 0.5, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 30, Duration: 0.5, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 38, Duration: 0.4, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 39, Duration: 0.4, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 40, Duration: 0.8, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 41, Duration: 0.8, StringVal: '', StringValSub: '', IntVal: 0 },
        { EffectType: 42, Duration: 0.6, StringVal: '120, -40', StringValSub: 'OutQuad', IntVal: 0 },
        { EffectType: 43, Duration: 0.6, StringVal: '1.25', StringValSub: 'OutQuad', IntVal: 0 },
        { EffectType: 44, Duration: 0.3, StringVal: 'true', StringValSub: '', IntVal: 0 },
        { EffectType: 45, Duration: 1.0, StringVal: 'zoom：1.8,blur:0.6,dist:2', StringValSub: 'OutQuad', IntVal: 0 }
      ],
      SoundData: [
        { PlayMode: 4, Bgm: '', Se: '', Volume: 0, Duration: 0.5 },
        { PlayMode: 0, Bgm: '', Se: 'se_step', Volume: 0.8, Duration: 0.35 },
        { PlayMode: 2, Bgm: '', Se: 'se_rain', Volume: 0.6, Duration: 0.5 },
        { PlayMode: 3, Bgm: '', Se: 'se_rain', Volume: 0, Duration: 0.4 }
      ],
      ScenarioSnippetCharacterLayoutModes: [],
      Snippets: [
        ...Array.from({ length: 6 }, (_, i) => ({ Index: i, Action: 2, ProgressBehavior: 0, ReferenceIndex: i, Delay: 0 })),
        { Index: 6, Action: 1, ProgressBehavior: 1, ReferenceIndex: 0, Delay: 0.1 },
        ...Array.from({ length: 41 }, (_, i) => ({ Index: 7 + i, Action: 6, ProgressBehavior: 1, ReferenceIndex: i, Delay: 0 })),
        ...Array.from({ length: 4 }, (_, i) => ({ Index: 48 + i, Action: 7, ProgressBehavior: 0, ReferenceIndex: i, Delay: 0.1 }))
      ]
    }
    const config = {
      title: 'parity',
      models: { 1: { name: '一歌', path: '01ichika/model.model3.json' } },
      characterModels: { 1: { default: 1 } }
    }
    const scenarioPath = path.join(dir, 'scenario.json')
    const configPath = path.join(dir, 'models.json')
    const outPath = path.join(dir, 'story.json')
    writeJson(scenarioPath, scenario)
    writeJson(configPath, config)

    execFileSync(process.execPath, [converter, '--scenario', scenarioPath, '--config', configPath, '--out', outPath])

    const story = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    const validated = StorySchema.parse(story)
    const types = new Set(validated.snippets.map((s) => s.type))

    for (const expectedType of [
      'ChangeLayoutMode',
      'CostumeChange',
      'LayoutAppear',
      'Move',
      'CharacterShake',
      'LayoutDepth',
      'LayoutClear',
      'Talk',
      'ShakeScreen',
      'ShakeWindow',
      'StopShakeScreen',
      'StopShakeWindow',
      'ChangeBackgroundImage',
      'Telop',
      'PlaceInfo',
      'FlashbackIn',
      'FlashbackOut',
      'SepiaIn',
      'SepiaOut',
      'SekaiIn',
      'SekaiOut',
      'AttachCharacterShader',
      'PlayScenarioEffect',
      'StopScenarioEffect',
      'SimpleSelectable',
      'FullScreenText',
      'Movie',
      'BlurIn',
      'BlurOut',
      'CameraMove',
      'CameraZoom',
      'BackgroundBlur',
      'DollyZoom',
      'BgmVolume',
      'PlaySe',
      'StopSe'
    ]) {
      assert.ok(types.has(expectedType), `missing snippet type ${expectedType}`)
    }

    const appear = validated.snippets.find((s) => s.type === 'LayoutAppear')
    assert.equal(appear.data.from.side, 'LeftOver')
    const move = validated.snippets.find((s) => s.type === 'Move')
    assert.equal(move.data.to.side, 'RightOver')
    const clear = validated.snippets.find((s) => s.type === 'LayoutClear')
    assert.equal(clear.data.from.under, true)
    assert.equal(clear.data.to.under, true)

    const talk = validated.snippets.find((s) => s.type === 'Talk')
    assert.equal(talk.data.closeWindowOnFinish, true)
    assert.equal(talk.data.effect, 'Internal')
    assert.equal(talk.progressBehavior, 'WaitFinished')
    assert.ok(talk.data.content.split('\n')[0].length === 30, 'line wraps at 30 CJK units')

    const bgmVol = validated.snippets.find((s) => s.type === 'BgmVolume')
    assert.equal(bgmVol.data.volume, 0)
    const oneShotSe = validated.snippets.find((s) => s.type === 'PlaySe' && !s.data.loop)
    assert.ok(Math.abs(oneShotSe.delay - 0.45) < 1e-6, 'deferred Duration offsets PlaySe delay')
    const dolly = validated.snippets.find((s) => s.type === 'DollyZoom')
    assert.equal(dolly.data.zoom, 1.8)
    const sekaiV2 = validated.snippets.find((s) => s.type === 'SekaiIn' && s.data.variant === 'v2')
    assert.ok(sekaiV2)
    const blurShader = validated.snippets.find(
      (s) => s.type === 'AttachCharacterShader' && s.data.shader === 'blur'
    )
    assert.equal(blurShader.data.level, 2.5)
  })
})
