/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 导出日志落盘：宿主把 worker 返回的 diagnostics 写成视频同目录的
 * <video>.log.json 与 <video>.log，响应里带 logPath/logJsonPath。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { writeExportDiagnostics } = require('../../out-host/host/exportDiagnostics.js')

function report() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-08T00:00:00.000Z',
    export: {
      mode: 'fast',
      width: 1280,
      height: 720,
      fps: 30,
      frameCount: 120,
      durationMs: 4000
    },
    summary: {
      models: 2,
      images: 1,
      snippets: 3,
      talks: 1,
      plannedDurationMs: 3000,
      actualDurationMs: 3100,
      avgAbsDriftMs: 50,
      ttsLines: 1,
      ttsTotalMs: 2800,
      motionEvents: 2,
      motionStarts: 1,
      motionInterrupts: 1,
      layoutAppears: 2,
      layoutClears: 2,
      logEntries: 1,
      anomalies: 1
    },
    snippets: [
      {
        index: 0,
        type: 'Talk',
        wait: false,
        delayMs: 100,
        plannedStartMs: 0,
        plannedDurationMs: 3000,
        actualStartMs: 50,
        actualDurationMs: 3100,
        driftMs: 50,
        durationDriftMs: 100,
        speaker: '瑞希',
        content: '今天也一起练吧。',
        ttsText: '今日も一緒に練習しよう。',
        japaneseTts: true,
        ttsDurationMs: 2800,
        actions: [{ at: 0, modelId: 1, motion: 'w-normal-nod01', cueAtMs: 0 }]
      }
    ],
    tts: [
      {
        index: 0,
        speaker: '瑞希',
        contentChars: 8,
        ttsTextChars: 12,
        japanese: true,
        durationMs: 2800,
        plannedDurationMs: 3000,
        synthesisText: '今日も一緒に練習しよう。'
      }
    ],
    motions: [
      {
        seq: 0,
        at: 1000,
        modelId: 1,
        channel: 0,
        name: 'w-normal-nod01',
        event: 'started',
        snippetIndex: 0,
        loadMs: 3,
        clipDurationMs: 2600
      }
    ],
    plan: {
      schemaVersion: 1,
      fps: 60,
      totalFrames: 240,
      totalMs: 4000,
      entries: [
        {
          index: 0,
          type: 'Talk',
          delayStartFrame: 0,
          startFrame: 0,
          endFrame: 180,
          durationFrames: 180,
          talk: {
            windowOpenFrames: 12,
            typingStartFrame: 12,
            typingEndFrame: 92,
            voiceEndFrame: 171,
            gateEndFrame: 171,
            computedEndFrame: 201
          },
          actions: [{ frame: 0, at: 0, modelId: 1, motion: 'w-normal-nod01' }]
        }
      ]
    },
    approximations: ['Pixi renderer is an approximation of the native SSE renderer'],
    anomalies: ['snippets[0] example anomaly'],
    logs: [
      {
        seq: 0,
        timestamp: 1000,
        level: 'INFO',
        module: 'VideoExportManager',
        message: 'Export started'
      }
    ]
  }
}

test('writeExportDiagnostics writes JSON and human-readable logs next to the video', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-diag-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const videoPath = path.join(dir, 'export-1.mp4')
  fs.writeFileSync(videoPath, 'video')
  const written = writeExportDiagnostics(videoPath, report())
  assert.equal(written.jsonPath, path.join(dir, 'export-1.log.json'))
  assert.equal(written.textPath, path.join(dir, 'export-1.log'))
  assert.equal(written.reportPath, path.join(dir, 'export-1.report.txt'))
  assert.ok(fs.existsSync(written.jsonPath))
  assert.ok(fs.existsSync(written.textPath))
  assert.ok(fs.existsSync(written.reportPath))

  const parsed = JSON.parse(fs.readFileSync(written.jsonPath, 'utf8'))
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.snippets[0].actions[0].at, 0)
  assert.equal(parsed.summary.avgAbsDriftMs, 50)

  const text = fs.readFileSync(written.textPath, 'utf8')
  assert.match(text, /=== MySekaiStoryteller export diagnostics ===/)
  assert.match(text, /\[000\] Talk/)
  assert.match(text, /action at=0 cue=0ms model=1 motion=w-normal-nod01/)
  assert.match(text, /snippets\[0\] example anomaly/)
  assert.match(text, /Export started/)
  assert.match(text, /--- frame plan ---/)
  assert.match(text, /typing=12\.\.92/)
  assert.match(text, /--- approximations ---/)

  const reportText = fs.readFileSync(written.reportPath, 'utf8')
  assert.match(reportText, /=== MySekaiStoryteller export report ===/)
  assert.match(reportText, /Pixi renderer is an approximation/)
  assert.match(reportText, /frame plan: 240 frames @ 60fps/)
})
