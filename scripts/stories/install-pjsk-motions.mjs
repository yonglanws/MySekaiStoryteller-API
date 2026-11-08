#!/usr/bin/env node
/**
 * 只下载故事真正用到的 PJSK 动作/表情并转成 motion3。
 *
 * 模型包自带的动作包很大（每个角色 300+ 条），但一场剧情通常只用几十条。
 * 本脚本从 SekaiStoryRipper 的 library 读取动作包清单，按故事里的 motion/facial
 * 名称精确下载、转换，并写进模型包的 motions/ 与 model3.json 索引。
 *
 * 用法：
 *   node scripts/stories/install-pjsk-motions.mjs \
 *     --story resources/stories/event_145_08.sekai-story.json \
 *     --config scripts/stories/event_145_08.motions.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { convertSseMotion } = require(path.join(ROOT, 'out-host/host/assets/motion3.js'))

const LIBRARY_BASE = 'https://assets.pjsk.moe/sekai-extra-assets/sekai-story/ripper/jp/library/'
const MODELS_DIR = path.join(ROOT, 'resources/models')

function parseArgs(argv) {
  const out = { story: '', config: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--story') out.story = next()
    else if (arg === '--config') out.config = next()
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!out.story || !out.config) throw new Error('--story and --config are required')
  return out
}

async function fetchJson(url, attempts = 6) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      console.warn(`retry ${attempt}/${attempts}: ${url} (${error.message})`)
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
    }
  }
  throw lastError
}

/**
 * assets.pjsk.moe 会在发完 body 后保持连接不关，Node fetch 会一直等到超时。
 * 用 curl 写临时文件：超时后保留已收到的字节，下一次用 -C - 续传，
 * 直到文件能完整 JSON.parse。这样比单次等待整个 body 稳得多。
 */
async function fetchMotionJson(url, attempts = 10) {
  const temp = path.join(
    os.tmpdir(),
    `msst-motion-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  )
  let lastError
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await execFileAsync(
        'curl',
        [
          '-sSL',
          '-C',
          '-',
          '--max-time',
          '15',
          '-H',
          'Referer: https://pjsk.moe/',
          '-H',
          'User-Agent: Mozilla/5.0',
          '-o',
          temp,
          url
        ],
        { maxBuffer: 32 * 1024 * 1024 }
      ).catch(() => undefined)
      try {
        return JSON.parse(fs.readFileSync(temp, 'utf8'))
      } catch (error) {
        lastError = error
        console.warn(`retry ${attempt}/${attempts}: ${url} (${error.message})`)
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
      }
    }
    throw lastError
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

/** 读取 SekaiStoryRipper 的动作包清单。 */
async function bundleFiles(bundle) {
  const data = await fetchJson(`${LIBRARY_BASE}${bundle}/_ripper.json`)
  return (data.files || []).map((file) => ({ ...file, url: file.path }))
}

function collectActions(story) {
  const needed = new Map()
  const ensure = (modelId) => {
    if (!needed.has(modelId)) needed.set(modelId, new Set())
    return needed.get(modelId)
  }
  for (const snippet of story.snippets) {
    const data = snippet.data || {}
    if (typeof data.modelId === 'number') {
      if (data.motion) ensure(data.modelId).add(data.motion)
      if (data.facial) ensure(data.modelId).add(data.facial)
    }
    for (const action of data.actions || []) {
      if (typeof action.modelId !== 'number') continue
      if (action.motion) ensure(action.modelId).add(action.motion)
      if (action.facial) ensure(action.modelId).add(action.facial)
    }
  }
  return needed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const story = JSON.parse(fs.readFileSync(args.story, 'utf8'))
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'))
  const needed = collectActions(story)

  const plans = []
  for (const [rawId, entry] of Object.entries(config.models)) {
    const modelId = Number(rawId)
    const names = needed.get(modelId)
    if (!names || names.size === 0) continue

    const model3Path = path.join(MODELS_DIR, entry.model3)
    const destDir = path.dirname(model3Path)
    const motionsDir = path.join(destDir, 'motions')
    fs.mkdirSync(motionsDir, { recursive: true })

    const files = await bundleFiles(entry.bundle)
    const byName = new Map()
    for (const file of files) {
      if (!file.path?.endsWith('.sse-motion.json')) continue
      const base = path.basename(file.path, '.sse-motion.json')
      byName.set(base, file.url)
      byName.set(base.toLowerCase(), file.url)
    }

    const clips = new Map()
    // 先读模型里已有的索引，保留之前装过的动作
    const model3 = JSON.parse(fs.readFileSync(model3Path, 'utf8'))
    const existing = model3.FileReferences?.Motions || {}
    for (const [name, entries] of Object.entries(existing)) {
      const file = entries?.[0]?.File
      if (file) {
        clips.set(name, {
          filename: path.basename(file),
          fadeIn: entries[0].FadeInTime,
          fadeOut: entries[0].FadeOutTime
        })
      }
    }

    const missing = [...names].filter((name) => !byName.has(name))
    if (missing.length > 0) {
      console.warn(`model ${modelId}: not in ${entry.bundle}: ${missing.join(', ')}`)
    }

    plans.push({ modelId, entry, model3Path, motionsDir, model3, clips, byName, names })
  }

  // 并行下载：动作文件很小，串行时会被单次连接卡住几分钟
  const tasks = []
  for (const plan of plans) {
    for (const name of plan.names) {
      if (plan.clips.has(name)) continue
      const relative = plan.byName.get(name) || plan.byName.get(name.toLowerCase())
      if (relative)
        tasks.push({ plan, name, url: `${LIBRARY_BASE}${plan.entry.bundle}/${relative}` })
    }
  }

  let next = 0
  let completed = 0
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      try {
        const raw = await fetchMotionJson(task.url)
        const converted = convertSseMotion(raw)
        if (converted.motion3.Curves.length === 0) continue
        const filename = `${converted.name.replace(/[^\w.-]+/g, '_')}.motion3.json`
        fs.writeFileSync(
          path.join(task.plan.motionsDir, filename),
          JSON.stringify(converted.motion3)
        )
        // 索引使用剧本里的名字（大小写可能和动作包文件名不同）
        task.plan.clips.set(task.name, {
          filename,
          fadeIn: converted.fadeIn,
          fadeOut: converted.fadeOut
        })
        completed++
        console.log(`model ${task.plan.modelId}: + ${converted.name}`)
      } catch (error) {
        console.warn(`model ${task.plan.modelId}: skip ${task.name}: ${error.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, Math.max(1, tasks.length)) }, worker))
  console.log(`downloaded ${completed}/${tasks.length} motions`)

  for (const plan of plans) {
    if (!plan.model3.FileReferences) plan.model3.FileReferences = {}
    const index = {}
    for (const [name, clip] of plan.clips) {
      index[name] = [
        {
          File: `motions/${clip.filename}`,
          FadeInTime: clip.fadeIn,
          FadeOutTime: clip.fadeOut
        }
      ]
    }
    plan.model3.FileReferences.Motions = index
    fs.writeFileSync(plan.model3Path, JSON.stringify(plan.model3, null, 2))
    console.log(`model ${plan.modelId}: ${plan.clips.size} motions indexed`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
