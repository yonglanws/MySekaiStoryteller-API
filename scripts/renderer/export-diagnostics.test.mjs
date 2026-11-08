/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 问题 5：每次导出都要留下可复查的逐句/逐动作/TTS 日志。
 * 这个测试锁死诊断构建：
 * - 每句有 planned/actual/drift、动作 cue、ttsText 日文标记；
 * - 动作被打断 <800ms、Talk 动作不在句首、入场无动作、Irodori 缺日文都会进 anomalies；
 * - 可读摘要包含 snippets / motion trace / anomalies 三段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function loadDiagnostics() {
  const context = vm.createContext({ console, Date })
  const modules = new Map()
  const compiled = new Map()
  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.join(renderer, relative)
    if (modules.has(filename)) return modules.get(filename)
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require) {\n${
            ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
              compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
              fileName: filename
            }).outputText
          }\n})`,
          { filename }
        )
      )
    }
    const exports = {}
    modules.set(filename, exports)
    const require = (name) => {
      assert.ok(name.startsWith('.'), `Unexpected platform dependency: ${name}`)
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return load('managers/video-export/ExportDiagnostics.ts')
}

function input() {
  const times = new Map([
    [
      0,
      {
        snippetIndex: 0,
        snippetType: 'LayoutAppear',
        wallStartMs: 1000,
        wallEndMs: 1800,
        wallDurationMs: 800
      }
    ],
    [
      1,
      {
        snippetIndex: 1,
        snippetType: 'Talk',
        wallStartMs: 1900,
        wallEndMs: 4900,
        wallDurationMs: 3000
      }
    ]
  ])
  return {
    snippets: [
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          motion: '',
          facial: '',
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 }
        }
      },
      {
        type: 'Talk',
        wait: false,
        delay: 0.1,
        data: {
          speaker: '瑞希',
          content: '今天也一起练吧。',
          ttsText: '今日も一緒に練習しよう。',
          modelId: 1,
          actions: [
            { at: 0.1, modelId: 1, motion: 'w-normal-nod01' },
            { at: 0, modelId: 2, facial: 'face_smile_01' }
          ]
        }
      },
      {
        type: 'Talk',
        wait: false,
        delay: 0.1,
        data: {
          speaker: '绘名',
          content: '嗯。',
          ttsText: 'うん。',
          modelId: 2,
          actions: [{ at: 0, modelId: 2, facial: 'face_smile_01' }]
        }
      },
      {
        type: 'Talk',
        wait: false,
        delay: 0.1,
        data: {
          speaker: '绘名',
          content: '还没翻译的句子。',
          ttsText: '还没翻译',
          modelId: 2
        }
      }
    ],
    timeline: [
      {
        snippetIndex: 0,
        snippetType: 'LayoutAppear',
        startTimeMs: 0,
        durationMs: 800,
        endTimeMs: 800,
        ttsDurationMs: 0,
        hasTTS: false,
        durationSource: 'type_default'
      },
      {
        snippetIndex: 1,
        snippetType: 'Talk',
        startTimeMs: 800,
        durationMs: 3000,
        endTimeMs: 3800,
        ttsDurationMs: 3000,
        hasTTS: true,
        durationSource: 'tts_audio'
      },
      {
        snippetIndex: 2,
        snippetType: 'Talk',
        startTimeMs: 3800,
        durationMs: 2000,
        endTimeMs: 5800,
        ttsDurationMs: 0,
        hasTTS: false,
        durationSource: 'content_estimation'
      }
    ],
    timestamps: {
      getRenderStartWallMs: () => 1000,
      getSnippetTimestamp: (index) => times.get(index)
    },
    ttsResults: new Map([
      [1, { durationMs: 3000, characterName: '瑞希', text: '今日も一緒に練習しよう。' }]
    ]),
    motion: [
      {
        seq: 0,
        at: 1000,
        modelId: 1,
        channel: 0,
        name: 'w-normal-nod01',
        event: 'interrupted',
        snippetIndex: 2,
        playedMs: 100
      }
    ],
    logs: [
      {
        seq: 0,
        timestamp: 1000,
        level: 'INFO',
        module: 'VideoExportManager',
        message: 'Export started'
      }
    ],
    exportMeta: {
      mode: 'fast',
      width: 1280,
      height: 720,
      fps: 30,
      frameCount: 120,
      durationMs: 4000
    },
    provider: 'irodori',
    storyCounts: { models: 2, images: 1 }
  }
}

test('buildExportDiagnostics records per-line timing, tts and action cues', () => {
  const { buildExportDiagnostics } = loadDiagnostics()
  const report = buildExportDiagnostics(input())
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.summary.snippets, 4)
  assert.equal(report.summary.talks, 3)
  assert.equal(report.summary.models, 2)
  assert.equal(report.summary.images, 1)
  assert.equal(report.summary.ttsLines, 3)
  assert.equal(report.summary.motionInterrupts, 1)
  assert.equal(report.summary.layoutAppears, 1)

  const talk = report.snippets[1]
  assert.equal(talk.plannedStartMs, 800)
  assert.equal(talk.actualStartMs, 900)
  assert.equal(talk.driftMs, 100)
  assert.equal(talk.plannedDurationMs, 3100, '计划时长包含该片段的 delay')
  assert.equal(talk.actualDurationMs, 3000)
  assert.equal(talk.ttsDurationMs, 3000)
  assert.equal(talk.japaneseTts, true)
  assert.equal(talk.actions.length, 2)
  assert.equal(talk.actions[0].at, 0.1)
  assert.equal(talk.actions[0].cueAtMs, 300)
  assert.equal(report.tts[0].contentChars, 8)
  assert.equal(report.tts[0].japanese, true)
  assert.deepEqual(
    report.logs.map((log) => log.message),
    ['Export started']
  )
})

test('disabled TTS does not report Irodori text/duration anomalies', () => {
  const { buildExportDiagnostics } = loadDiagnostics()
  const disabled = {
    ...input(),
    ttsEnabled: false,
    ttsResults: new Map()
  }
  const report = buildExportDiagnostics(disabled)
  assert.equal(
    report.anomalies.some((line) => /TTS 时长|日文 ttsText/.test(line)),
    false,
    report.anomalies.join('\n')
  )
})

test('steady cumulative drift is not reported once per snippet', () => {
  const { buildExportDiagnostics } = loadDiagnostics()
  const data = input()
  data.snippets = data.snippets.slice(0, 3)
  data.timeline = data.timeline.slice(0, 3)
  data.motion = []
  const planned = [
    { start: 0, duration: 800 },
    { start: 800, duration: 3100 },
    { start: 3800, duration: 2100 }
  ]
  data.timestamps = {
    getRenderStartWallMs: () => 1000,
    getSnippetTimestamp: (index) => ({
      snippetIndex: index,
      snippetType: data.snippets[index].type,
      wallStartMs: 1000 + planned[index].start + 300 + index * 2,
      wallEndMs: 1000 + planned[index].start + 300 + index * 2 + planned[index].duration,
      wallDurationMs: planned[index].duration
    })
  }
  const report = buildExportDiagnostics(data)
  const driftLines = report.anomalies.filter((line) => line.includes('时间线漂移'))
  assert.equal(driftLines.length, 1, report.anomalies.join('\n'))
  assert.match(driftLines[0], /snippets\[0\]/)
  assert.match(driftLines[0], /较上一句 \+300ms/)
})

test('buildExportDiagnostics tolerates motionless Appear and flags late cues/short interrupts', () => {
  const { buildExportDiagnostics } = loadDiagnostics()
  const report = buildExportDiagnostics(input())
  assert.equal(
    report.anomalies.some((line) => line.includes('LayoutAppear') && line.includes('没有入场动作')),
    false,
    'Appear 会走 startEntryMotion 兜底，不能逐条报异常'
  )
  assert.ok(
    report.anomalies.some((line) => line.includes('Talk 动作 at=0.1')),
    report.anomalies.join('\n')
  )
  assert.ok(
    report.anomalies.some(
      (line) => line.includes('播放 100ms 就被打断') && line.includes('<400ms')
    ),
    report.anomalies.join('\n')
  )
  assert.ok(
    report.anomalies.some((line) => line.includes('缺少日文 ttsText')),
    report.anomalies.join('\n')
  )
})

test('formatDiagnosticsText produces a readable per-snippet log', () => {
  const { buildExportDiagnostics, formatDiagnosticsText } = loadDiagnostics()
  const text = formatDiagnosticsText(buildExportDiagnostics(input()))
  assert.match(text, /=== MySekaiStoryteller export diagnostics ===/)
  assert.match(text, /--- snippets ---/)
  assert.match(text, /\[001\] Talk/)
  assert.match(text, /action at=0\.1 cue=300ms model=1 motion=w-normal-nod01/)
  assert.match(text, /--- motion trace ---/)
  assert.match(text, /interrupted w-normal-nod01/)
  assert.match(text, /--- anomalies ---/)
  assert.match(text, /--- logs \(1\) ---/)
})
