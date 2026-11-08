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
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const converter = path.join(here, 'pjsk-scenario.mjs')

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
