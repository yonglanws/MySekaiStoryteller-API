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
            { at: 0.5, modelId: 1, motion: 'w-normal-nod01' },
            { at: 1.4, modelId: 2, facial: 'face_smile_01' }
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
        startTimeMs: 900,
        durationMs: 3000,
        endTimeMs: 3900,
        ttsDurationMs: 3000,
        hasTTS: true,
        durationSource: 'tts_audio'
      },
      {
        snippetIndex: 2,
        snippetType: 'Talk',
        startTimeMs: 4000,
        durationMs: 2000,
        endTimeMs: 6000,
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
  assert.equal(talk.actions[0].at, 0.5)
  assert.equal(talk.actions[0].cueAtMs, 1500)
  assert.equal(report.tts[0].contentChars, 8)
  assert.equal(report.tts[0].japanese, true)
  assert.deepEqual(
    report.logs.map((log) => log.message),
    ['Export started']
  )
})

test('diagnostics carries the video-frame -> story-frame map', () => {
  const { buildExportDiagnostics } = loadDiagnostics()
  const report = buildExportDiagnostics(input())
  assert.ok(
    report.frameMap,
    'frameMap must be present so video frames can be compared to plan frames'
  )
  assert.equal(report.frameMap.storyFps, 60)
  assert.equal(report.frameMap.videoFps, 30)
  assert.equal(report.frameMap.storyFrames, report.plan.totalFrames)
  assert.equal(report.frameMap.videoFrames, 120)
  assert.equal(report.frameMap.videoFrameToStoryFrame, 'floor(n*60/30)')
  assert.equal(report.frameMap.playcoreWarmupStoryFrames, 10)
  assert.equal(
    report.frameMap.timelineOriginStoryFrame,
    10,
    'plannedStartMs/actualStartMs are 0-based at story frame 10'
  )

  // 60fps 时成片帧 n 就是故事帧 n；公式退化成 n。
  const sixty = buildExportDiagnostics({
    ...input(),
    exportMeta: { ...input().exportMeta, fps: 60, frameCount: 240 }
  })
  assert.equal(sixty.frameMap.videoFps, 60)
  assert.equal(sixty.frameMap.videoFrameToStoryFrame, 'n')
  assert.equal(sixty.frameMap.videoFrames, 240)
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

test('cumulative drift beyond 1s is reported once at the jump, not per snippet', () => {
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
  // 长片累计了 1.2s 固定偏移，每句只增加 2ms 的渲染抖动。
  data.timestamps = {
    getRenderStartWallMs: () => 1000,
    getSnippetTimestamp: (index) => ({
      snippetIndex: index,
      snippetType: data.snippets[index].type,
      wallStartMs: 1000 + planned[index].start + 1200 + index * 2,
      wallEndMs: 1000 + planned[index].start + 1200 + index * 2 + planned[index].duration,
      wallDurationMs: planned[index].duration
    })
  }
  const report = buildExportDiagnostics(data)
  const driftLines = report.anomalies.filter((line) => line.includes('时间线漂移'))
  // 只报第一句的跳变；之后稳定在 1s 以上的累计偏移不再逐句刷屏。
  assert.equal(driftLines.length, 1, driftLines.join('\n'))
  assert.match(driftLines[0], /snippets\[0\]/)
  assert.ok(report.snippets[2].driftMs > 1000, 'cumulative drift is still recorded per snippet')
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
    report.anomalies.some((line) => line.includes('Talk 动作 at=1.4')),
    report.anomalies.join('\n')
  )
  assert.equal(
    report.anomalies.some((line) => line.includes('Talk 动作 at=0.5')),
    false,
    '合法句中 2 拍 cue (0<=at<=1) 不应报异常'
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
  assert.match(
    text,
    /frame map: video frame n = story frame floor\(n\*60\/30\).*PlayCore warmup 10 frames are part of the video/
  )
  assert.match(text, /--- snippets ---/)
  assert.match(text, /\[001\] Talk/)
  assert.match(text, /action at=0\.5 cue=1500ms model=1 motion=w-normal-nod01/)
  assert.match(text, /--- motion trace ---/)
  assert.match(text, /interrupted w-normal-nod01/)
  assert.match(text, /--- anomalies ---/)
  assert.match(text, /--- logs \(1\) ---/)
})

test('buildExportDiagnostics aligns real pre-fenced delays & Now durations without double-counting', () => {
  const { buildExportDiagnostics } = loadDiagnostics()
  const report = buildExportDiagnostics({
    snippets: [
      {
        type: 'SideFade',
        progressBehavior: 'Now',
        wait: false,
        delay: 0.2,
        data: { direction: 'Left', mode: 'In', duration: 0.5 }
      },
      {
        type: 'Talk',
        progressBehavior: 'WaitFinished',
        wait: true,
        delay: 1.0,
        data: { speaker: '瑞希', content: 'あ', ttsText: 'あ。', modelId: 1 }
      }
    ],
    timeline: [
      {
        snippetIndex: 0,
        snippetType: 'SideFade',
        startTimeMs: 200,
        durationMs: 500,
        endTimeMs: 700,
        ttsDurationMs: 0,
        hasTTS: false,
        durationSource: 'data_duration'
      },
      {
        snippetIndex: 1,
        snippetType: 'Talk',
        startTimeMs: 1700,
        durationMs: 2266.667,
        endTimeMs: 3966.667,
        ttsDurationMs: 0,
        hasTTS: false,
        durationSource: 'content_estimation'
      }
    ],
    timestamps: {
      getRenderStartWallMs: () => 5000,
      getSnippetTimestamp: (idx) =>
        idx === 0
          ? {
              snippetIndex: 0,
              snippetType: 'SideFade',
              wallStartMs: 5000,
              wallEndMs: 5700,
              wallDurationMs: 700
            }
          : {
              snippetIndex: 1,
              snippetType: 'Talk',
              wallStartMs: 5700,
              wallEndMs: 8967,
              wallDurationMs: 3267
            }
    },
    ttsResults: new Map(),
    motion: [],
    logs: [],
    exportMeta: {
      mode: 'fast',
      width: 1280,
      height: 720,
      fps: 60,
      frameCount: 240,
      durationMs: 3967
    },
    ttsEnabled: false
  })

  // Now 片段不再被归零为 0ms；delay 不再被 cumulativeDelayMs 二次累加
  assert.equal(report.snippets[0].plannedStartMs, 0)
  assert.equal(report.snippets[0].plannedDurationMs, 700)
  assert.equal(report.snippets[0].driftMs, 0)
  assert.equal(report.snippets[0].durationDriftMs, 0)
  assert.equal(report.snippets[1].plannedStartMs, 700)
  assert.equal(Math.round(report.snippets[1].plannedDurationMs), 3267)
  assert.equal(report.snippets[1].driftMs, 0)
  assert.equal(report.anomalies.length, 0)
})

test('punctuation-only Talk does not trigger missing Irodori ttsText or duration anomalies', () => {
  const { buildExportDiagnostics } = loadDiagnostics()
  const data = input()
  data.snippets = [
    {
      type: 'Talk',
      wait: true,
      delay: 0,
      data: { speaker: '绘名', content: '……！', ttsText: '', modelId: 2 }
    }
  ]
  data.timeline = [
    {
      snippetIndex: 0,
      snippetType: 'Talk',
      startTimeMs: 0,
      durationMs: 1200,
      endTimeMs: 1200,
      ttsDurationMs: 0,
      hasTTS: false,
      durationSource: 'content_estimation'
    }
  ]
  data.motion = []
  data.ttsResults = new Map()
  data.timestamps = {
    getRenderStartWallMs: () => 1000,
    getSnippetTimestamp: () => ({
      snippetIndex: 0,
      snippetType: 'Talk',
      wallStartMs: 1000,
      wallEndMs: 2200,
      wallDurationMs: 1200
    })
  }
  const report = buildExportDiagnostics(data)
  assert.equal(
    report.anomalies.some((line) => /TTS 时长|日文 ttsText/.test(line)),
    false,
    report.anomalies.join('\n')
  )
})
