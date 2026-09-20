#!/usr/bin/env node
/**
 * 导出性能基准测试：
 *   node scripts/bench-export.mjs <apiUrl> <story> <label> [timeoutMs]
 * 提交导出，记录墙钟耗时，打印 API 响应（含 phaseTimings）与 ffprobe 摘要。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'

// 用原生 http 请求：长故事导出数分钟，避免 undici 默认 headers 超时
function postExport(apiUrl, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}/api/v1/export`)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: timeoutMs
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode, json: { success: false, message: data.slice(0, 200) } })
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('client timeout')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

const API_URL = process.argv[2] || 'http://127.0.0.1:9881'
const STORY = process.argv[3]
const LABEL = process.argv[4] || 'run'
const TIMEOUT_MS = Number(process.argv[5]) || 1800000

if (!STORY) {
  console.error('usage: node scripts/bench-export.mjs <apiUrl> <story> <label> [timeoutMs]')
  process.exit(1)
}

const story = JSON.parse(readFileSync(STORY, 'utf-8'))
const snippetCount = Array.isArray(story.snippets) ? story.snippets.length : 0

function ffprobe(file) {
  try {
    const require = createRequire(import.meta.url)
    const ffmpeg = require('ffmpeg-static')
    const ffprobePath = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
    return JSON.parse(
      execFileSync(
        existsSync(ffprobePath) ? ffprobePath : 'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
        { encoding: 'utf-8' }
      )
    )
  } catch {
    return null
  }
}

const startedAt = Date.now()
const { status, json: result } = await postExport(API_URL, { story, timeout: TIMEOUT_MS }, TIMEOUT_MS)
const elapsedMs = Date.now() - startedAt

const line = {
  label: LABEL,
  ok: result.success === true,
  httpStatus: status,
  snippets: snippetCount,
  wallMs: elapsedMs,
  videoDuration: result.duration,
  fileSizeMB: result.fileSize ? +(result.fileSize / 1024 / 1024).toFixed(2) : null,
  phaseTimings: result.timings || null
}

if (result.success && result.videoPath && existsSync(result.videoPath)) {
  const probe = ffprobe(result.videoPath)
  if (probe) {
    const v = (probe.streams || []).find((s) => s.codec_type === 'video')
    const a = (probe.streams || []).find((s) => s.codec_type === 'audio')
    line.probe = {
      duration: probe.format?.duration ? Number(probe.format.duration).toFixed(2) : null,
      bitrateKbps: probe.format?.bit_rate ? Math.round(Number(probe.format.bit_rate) / 1000) : null,
      video: v ? `${v.codec_name} ${v.width}x${v.height} ${v.r_frame_rate}fps` : null,
      audio: a ? `${a.codec_name} ${a.sample_rate}Hz` : null
    }
  }
  line.videoPath = result.videoPath
} else if (!result.success) {
  line.error = result.message
}

console.log(JSON.stringify(line))
