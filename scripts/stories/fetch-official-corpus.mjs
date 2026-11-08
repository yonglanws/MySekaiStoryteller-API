#!/usr/bin/env node
/**
 * 下载官方剧情语料（event story）用于分析/评测，不落进仓库。
 *
 * 数据源：
 *   - 活动与分集：https://sekai-world.github.io/sekai-master-db-diff/{events,eventStories}.json
 *   - 剧情脚本：https://storage.exmeaning.com/sekai-<region>-assets/event_story/<eventAssets>/scenario/<scenarioId>.json
 *     （注意是活动级 assetbundleName，不是分集级 event_xxx_01）
 *
 * 用法：
 *   node scripts/stories/fetch-official-corpus.mjs --out D:/msst-lab/corpus
 *   node scripts/stories/fetch-official-corpus.mjs --out ... --preset nightcord
 *   node scripts/stories/fetch-official-corpus.mjs --out ... --events 39,145,199 --regions jp,cn
 *
 * 输出：
 *   <out>/meta/events.json
 *   <out>/meta/eventStories.json
 *   <out>/raw/<region>/<scenarioId>.json
 *   <out>/index.json
 */
import fs from 'node:fs'
import path from 'node:path'

const MASTER_BASE = 'https://sekai-world.github.io/sekai-master-db-diff'
const STORAGE_BASE = 'https://storage.exmeaning.com/sekai-{region}-assets'
const NIGHTCORD_UNIT = 'school_refusal'

function parseArgs(argv) {
  const out = {
    out: '',
    preset: 'mixed',
    events: '',
    regions: 'jp,cn',
    concurrency: 8,
    force: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--out') out.out = next()
    else if (arg === '--preset') out.preset = next()
    else if (arg === '--events') out.events = next()
    else if (arg === '--regions') out.regions = next()
    else if (arg === '--concurrency') out.concurrency = Number(next())
    else if (arg === '--force') out.force = true
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!out.out) throw new Error('--out is required')
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJson(url, { retries = 4 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'msst-script-lab/1.0' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      return await res.json()
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError
}

async function fetchText(url, { retries = 4 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'msst-script-lab/1.0' } })
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} ${url}`)
        error.status = res.status
        throw error
      }
      return await res.text()
    } catch (error) {
      lastError = error
      if (error.status === 404) throw error
      if (attempt < retries) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError
}

function pickEvents(events, stories, args) {
  const storiesByEvent = new Map(stories.map((story) => [story.eventId, story]))
  const available = events.filter((event) => storiesByEvent.has(event.id))

  if (args.events) {
    const ids = new Set(
      args.events
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value))
    )
    return available.filter((event) => ids.has(event.id))
  }

  if (args.preset === 'all') return available
  if (args.preset === 'nightcord') return available.filter((event) => event.unit === NIGHTCORD_UNIT)

  // mixed：全部 Nightcord + 其他组合按年代均匀取样，覆盖不同演出习惯
  const nightcord = available.filter((event) => event.unit === NIGHTCORD_UNIT)
  const others = available.filter((event) => event.unit !== NIGHTCORD_UNIT)
  const step = Math.max(1, Math.floor(others.length / 16))
  const sampled = others.filter((_, index) => index % step === 0).slice(0, 16)
  return [...nightcord, ...sampled].sort((a, b) => a.id - b.id)
}

async function writeJson(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, JSON.stringify(value, null, 2))
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(args.out)
  const metaDir = path.join(outDir, 'meta')
  await fs.promises.mkdir(metaDir, { recursive: true })

  const eventsFile = path.join(metaDir, 'events.json')
  const storiesFile = path.join(metaDir, 'eventStories.json')
  const events = fs.existsSync(eventsFile)
    ? JSON.parse(await fs.promises.readFile(eventsFile, 'utf8'))
    : await fetchJson(`${MASTER_BASE}/events.json`)
  const stories = fs.existsSync(storiesFile)
    ? JSON.parse(await fs.promises.readFile(storiesFile, 'utf8'))
    : await fetchJson(`${MASTER_BASE}/eventStories.json`)
  await writeJson(eventsFile, events)
  await writeJson(storiesFile, stories)

  const storiesByEvent = new Map(stories.map((story) => [story.eventId, story]))
  const selected = pickEvents(events, stories, args)
  const regions = args.regions
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const jobs = []
  for (const event of selected) {
    const story = storiesByEvent.get(event.id)
    if (!story) continue
    for (const episode of story.eventStoryEpisodes ?? []) {
      for (const region of regions) {
        jobs.push({
          region,
          eventId: event.id,
          eventName: event.name,
          eventUnit: event.unit,
          eventAssets: story.assetbundleName,
          episodeNo: episode.episodeNo,
          title: episode.title,
          scenarioId: episode.scenarioId
        })
      }
    }
  }

  let downloaded = 0
  let skipped = 0
  let missing = 0
  const entries = await pool(jobs, args.concurrency, async (job) => {
    const file = path.join(outDir, 'raw', job.region, `${job.scenarioId}.json`)
    const entry = { ...job, path: file, bytes: 0, ok: false }
    if (!args.force && fs.existsSync(file) && fs.statSync(file).size > 0) {
      entry.bytes = fs.statSync(file).size
      entry.ok = true
      skipped++
      return entry
    }
    const url = `${STORAGE_BASE.replace('{region}', job.region)}/event_story/${job.eventAssets}/scenario/${job.scenarioId}.json`
    try {
      const text = await fetchText(url)
      const data = JSON.parse(text)
      if (!Array.isArray(data.TalkData) || !Array.isArray(data.Snippets)) {
        throw new Error('not a scenario')
      }
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, text)
      entry.bytes = Buffer.byteLength(text)
      entry.ok = true
      downloaded++
    } catch (error) {
      if (error.status === 404) missing++
      else console.warn(`fail ${job.region}/${job.scenarioId}: ${error.message}`)
    }
    return entry
  })

  const index = {
    generatedAt: new Date().toISOString(),
    source: { master: MASTER_BASE, storage: STORAGE_BASE },
    events: selected.map((event) => ({
      id: event.id,
      name: event.name,
      unit: event.unit,
      assetbundleName: storiesByEvent.get(event.id)?.assetbundleName ?? '',
      outline: storiesByEvent.get(event.id)?.outline ?? ''
    })),
    episodes: entries.filter((entry) => entry.ok)
  }
  await writeJson(path.join(outDir, 'index.json'), index)

  console.log(
    `events=${selected.length} jobs=${jobs.length} downloaded=${downloaded} skipped=${skipped} missing=${missing}`
  )
  console.log(`out=${outDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
