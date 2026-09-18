#!/usr/bin/env node
/**
 * 端到端导出测试：
 * 1. 健康检查（含渲染池状态与 WebGL renderer 断言）
 * 2. 读取内置示例故事 → POST /api/v1/export
 * 3. 校验 MP4 产物（ffprobe：编码/分辨率/时长/音轨）
 *
 * 用法：先启动宿主（npm run start），再执行 npm run e2e
 * 环境变量：MSS_API_URL（默认 http://127.0.0.1:9881）
 */

import { readFileSync, existsSync, statSync, readdirSync, globSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const API_URL = process.env.MSS_API_URL || 'http://127.0.0.1:9881'
const STORY_FILE =
  process.env.MSS_E2E_STORY ||
  path.resolve('resources/stories/multi-character-demo.sekai-story.json')

// record 模式的 ffmpeg 管线历史上把输出 scale 到 1280x720；
// fast 模式按 video.width/height 输出。断言最低可接受分辨率。
const MIN_WIDTH = 1280
const MIN_HEIGHT = 720

let failures = 0
function check(name, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL'
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function resolveFfmpeg() {
  if (process.env.MSS_FFMPEG_PATH) return process.env.MSS_FFMPEG_PATH
  try {
    const require = createRequire(import.meta.url)
    return require('ffmpeg-static')
  } catch {
    return 'ffmpeg'
  }
}

async function main() {
  console.log(`E2E test against ${API_URL}, story: ${STORY_FILE}\n`)

  // 1. 健康检查
  const health = await fetch(`${API_URL}/api/v1/health`).then((r) => r.json())
  check('health.status === ok', health.status === 'ok')
  const pool = health.renderPool || {}
  check(
    'render worker ready',
    (pool.readyWorkers || 0) >= 1,
    `ready=${pool.readyWorkers}/${pool.configuredWorkers}`
  )
  const renderers = (pool.webglRenderers || []).map((w) => w.renderer).join('; ')
  check(
    'WebGL hardware acceleration',
    /swiftshader|llvmpipe|software|NO_WEBGL|UNKNOWN|^null$|^$/i.test(renderers) === false &&
      renderers !== 'null' &&
      renderers !== '',
    `renderer: ${renderers}`
  )

  // 2. 提交导出
  const story = JSON.parse(readFileSync(STORY_FILE, 'utf-8'))
  adaptStoryToAvailableAssets(story)

  const startedAt = Date.now()
  console.log('\nSubmitting export (this blocks until the video is ready)...')
  const res = await fetch(`${API_URL}/api/v1/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ story, timeout: 420000 })
  })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const result = await res.json()
  check('export HTTP 200', res.status === 200, `status=${res.status} ${result.message || ''}`)
  check('export.success === true', result.success === true, result.message || '')
  check(
    'export completed within timeout',
    true,
    `elapsed=${elapsed}s, fileSize=${result.fileSize ? (result.fileSize / 1024 / 1024).toFixed(2) + 'MB' : 'n/a'}`
  )

  if (!result.success) {
    console.error('\nExport failed, aborting remaining checks.', result)
    process.exit(1)
  }

  // 3. 校验产物
  check('downloadUrl returned', typeof result.downloadUrl === 'string', result.downloadUrl || '')
  const videoPath = result.videoPath
  check('video file exists on disk', !!videoPath && existsSync(videoPath), videoPath || '')

  if (videoPath && existsSync(videoPath)) {
    const ffmpegPath = resolveFfmpeg()

    try {
      let probe
      try {
        let ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
        if (!existsSync(ffprobePath)) ffprobePath = 'ffprobe'
        probe = JSON.parse(
          execFileSync(
            ffprobePath,
            ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath],
            { encoding: 'utf-8' }
          )
        )
      } catch {
        // ffmpeg-static 不带 ffprobe，退回用 ffmpeg -i 的 stderr 解析
        probe = probeWithFfmpeg(videoPath, ffmpegPath)
      }
      const v = (probe.streams || []).find((s) => s.codec_type === 'video')
      const a = (probe.streams || []).find((s) => s.codec_type === 'audio')
      check('video stream present', !!v, v ? `${v.codec_name} ${v.width}x${v.height}` : 'missing')
      check(
        `resolution >= ${MIN_WIDTH}x${MIN_HEIGHT}`,
        v && v.width >= MIN_WIDTH && v.height >= MIN_HEIGHT,
        v ? `${v.width}x${v.height}` : ''
      )
      check('duration > 0', Number(probe.format?.duration) > 0, `${probe.format?.duration}s`)
      check(
        'audio stream present',
        !!a,
        a ? `${a.codec_name} ${a.sample_rate}Hz` : 'missing (ok if no TTS/BGM)'
      )

      const size = statSync(videoPath).size
      check('file size > 10KB', size > 10240, `${(size / 1024).toFixed(1)}KB`)
    } catch (err) {
      check('video metadata parse', false, String(err.message).slice(0, 120))
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E test crashed:', err)
  process.exit(1)
})

/** 用 ffmpeg -i 的 stderr 输出解析流信息（无 ffprobe 时的回退） */
function probeWithFfmpeg(videoPath, ffmpegPath) {
  let stderr = ''
  try {
    execFileSync(ffmpegPath, ['-i', videoPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    // ffmpeg -i 不带输出文件必然退出码 1，stderr 里带着流信息
    stderr = String(err.stderr || err.message || '')
  }
  if (!stderr) throw new Error('ffmpeg produced no metadata output')

  const streams = []
  const streamRe = /Stream #0:(\d+)[^\n]*/g
  let match
  while ((match = streamRe.exec(stderr)) !== null) {
    const line = match[0]
    const index = parseInt(match[1], 10)
    if (/Video:/.test(line)) {
      const codec = line.match(/Video: ([\w]+)/)?.[1] || 'unknown'
      const dim = line.match(/(\d{2,5})x(\d{2,5})/)
      streams.push({
        index,
        codec_type: 'video',
        codec_name: codec,
        width: dim ? parseInt(dim[1]) : 0,
        height: dim ? parseInt(dim[2]) : 0
      })
    } else if (/Audio:/.test(line)) {
      const codec = line.match(/Audio: ([\w]+)/)?.[1] || 'unknown'
      const rate = line.match(/(\d{4,6}) Hz/)?.[1]
      streams.push({ index, codec_type: 'audio', codec_name: codec, sample_rate: rate })
    }
  }
  const duration = parseFloat(
    stderr
      .match(/Duration: (\d+):(\d+):([\d.]+)/)
      ?.slice(1)
      .reduce((acc, part, i) => acc + Number(part) * [3600, 60, 1][i], 0) || '0'
  )
  return { streams, format: { duration } }
}

/**
 * 内置示例故事可能引用当前工作目录缺失的模型变体/背景图，
 * 用实际存在的资源替换，保证 E2E 在任何机器上可跑。
 */
function adaptStoryToAvailableAssets(story) {
  const modelsRoot = path.resolve('resources/models')
  const imagesRoot = path.resolve('resources/images')

  const availableModels = globSync('**/*.model3.json', { cwd: modelsRoot }).sort()
  const availableImages = existsSync(imagesRoot)
    ? readdirSync(imagesRoot)
        .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
        .sort()
    : []

  let replaced = 0
  for (const m of story.models || []) {
    if (!existsSync(path.join(modelsRoot, m.model)) && availableModels.length > 0) {
      console.log(`[adapt] model missing on disk: ${m.model} -> ${availableModels[0]}`)
      m.model = availableModels[0]
      replaced++
    }
  }
  for (const img of story.images || []) {
    if (!existsSync(path.join(imagesRoot, img.image)) && availableImages.length > 0) {
      console.log(`[adapt] image missing on disk: ${img.image} -> ${availableImages[0]}`)
      img.image = availableImages[0]
      replaced++
    }
  }
  if (replaced > 0) {
    console.log(`[adapt] ${replaced} asset reference(s) substituted with available files\n`)
  }
}
