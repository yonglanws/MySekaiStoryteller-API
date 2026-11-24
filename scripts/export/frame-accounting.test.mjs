/**
 * 导出诊断的 plan ↔ 成片帧数一致性：
 * - 成片帧 n 覆盖故事帧 floor(n×60/fps)，plan 的 N 个故事帧（含 PlayCore 前 10 帧）
 *   应产出 ceil(N×fps/60) 个视频帧；
 * - fast 模式的 `timings.encodedFrames` 是帧泵实际输出帧数，与 `frameCount` 不等
 *   就是帧泵/收尾缺陷，必须进 anomalies。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRendererLoader } from './lib/renderer-loader.mjs'

const { load } = createRendererLoader()
const { buildExportDiagnostics, formatDiagnosticsText } = load(
  'managers/video-export/ExportDiagnostics.ts'
)

const SNIPPETS = [
  { type: 'BlackOut', delay: 0, wait: true, data: { color: 'black', duration: 0 } },
  { type: 'PlaySe', delay: 0, wait: true, data: { se: 'se_test', timing: 'before' } },
  { type: 'BlackOut', delay: 0, wait: true, data: { color: 'black', duration: 600 } }
]

const TIMELINE = [
  {
    snippetIndex: 0,
    snippetType: 'BlackOut',
    startTimeMs: 0,
    durationMs: 0,
    endTimeMs: 0,
    ttsDurationMs: 0,
    hasTTS: false,
    blocking: true,
    durationSource: 'fixed'
  },
  {
    snippetIndex: 1,
    snippetType: 'PlaySe',
    startTimeMs: 0,
    durationMs: 0,
    endTimeMs: 0,
    ttsDurationMs: 0,
    hasTTS: false,
    blocking: true,
    durationSource: 'fixed'
  },
  {
    snippetIndex: 2,
    snippetType: 'BlackOut',
    startTimeMs: 0,
    durationMs: 600,
    endTimeMs: 600,
    ttsDurationMs: 0,
    hasTTS: false,
    blocking: true,
    durationSource: 'fixed'
  }
]

function diagnosticsInput(exportMeta) {
  return {
    snippets: SNIPPETS,
    timeline: TIMELINE,
    timestamps: {
      getRenderStartWallMs: () => 0,
      getTimelineStartWallMs: () => 166.667,
      getSnippetTimestamp: () => null
    },
    ttsResults: new Map(),
    motion: [],
    logs: [],
    exportMeta: {
      mode: 'fast 1280x720 60fps',
      width: 1280,
      height: 720,
      fps: 60,
      ...exportMeta
    },
    ttsEnabled: false
  }
}

function frameAnomalies(report) {
  return report.anomalies.filter((line) => line.includes('帧'))
}

test('60fps report maps video frame n to story frame n including the PlayCore warmup', () => {
  const report = buildExportDiagnostics(
    diagnosticsInput({
      videoFps: 60,
      frameCount: 77,
      durationMs: 1283,
      timings: { frames: 77, encodedFrames: 77 }
    })
  )
  assert.equal(report.plan.totalFrames, 77)
  assert.equal(report.frameMap.storyFrames, 77)
  assert.equal(report.frameMap.videoFrames, 77)
  assert.equal(report.frameMap.pumpFrames, 77)
  assert.equal(report.frameMap.videoFrameToStoryFrame, 'n')
  assert.equal(report.frameMap.playcoreWarmupStoryFrames, 10)
  assert.equal(frameAnomalies(report).length, 0, frameAnomalies(report).join(' | '))
})

test('25fps report expects ceil(plan×25/60) frames and flags a short pump', () => {
  const good = buildExportDiagnostics(
    diagnosticsInput({
      videoFps: 25,
      frameCount: 33,
      durationMs: 1320,
      timings: { frames: 33, encodedFrames: 33 }
    })
  )
  assert.equal(good.frameMap.storyFrames, 77)
  assert.equal(good.frameMap.videoFrames, 33)
  assert.equal(good.frameMap.pumpFrames, 33)
  assert.equal(good.frameMap.videoFrameToStoryFrame, 'floor(n*60/25)')
  assert.equal(frameAnomalies(good).length, 0, frameAnomalies(good).join(' | '))

  // 旧帧泵在 25fps、77 故事帧时只拍 32 帧（round 到最近输出帧）。
  const short = buildExportDiagnostics(
    diagnosticsInput({
      videoFps: 25,
      frameCount: 32,
      durationMs: 1280,
      timings: { frames: 32, encodedFrames: 32 }
    })
  )
  assert.ok(
    frameAnomalies(short).some((line) => line.includes('应有的 33 帧不一致')),
    short.anomalies.join('\n')
  )

  // 帧泵少拍但记录按 plan 写：两条不一致都要报。
  const truncated = buildExportDiagnostics(
    diagnosticsInput({
      videoFps: 25,
      frameCount: 33,
      durationMs: 1320,
      timings: { frames: 33, encodedFrames: 32 }
    })
  )
  assert.ok(
    frameAnomalies(truncated).some((line) => line.includes('帧泵实际输出 32 帧')),
    truncated.anomalies.join('\n')
  )
})

test('report text shows the plan, the frame count and the pumped count', () => {
  const text = formatDiagnosticsText(
    buildExportDiagnostics(
      diagnosticsInput({
        videoFps: 60,
        frameCount: 77,
        durationMs: 1283,
        timings: { frames: 77, encodedFrames: 77 }
      })
    )
  )
  assert.match(text, /77 story frames -> 77 video frames \(pump 77\)/)
  assert.match(text, /PlayCore warmup 10 frames are part of the video/)
})
