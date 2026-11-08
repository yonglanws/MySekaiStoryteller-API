#!/usr/bin/env node
/**
 * 生成背景名索引：把 `bg_a000301` 这类无语义文案 id 映射成官方剧情里显示的地点名。
 *
 * 名字来源与 ournotes-player 的 stage caption 相同：剧情在某个背景生效期间会显示
 * PlaceInfo / ScenarioTelop 文本（例如「教室」「瑞希の部屋」）。这里统计每个背景
 * 出现过的地点文本，取最高频的一条作为 name，其余作为 aliases。
 *
 * 两种数据源：
 *   --corpus <dir>   已下载的官方 scenario JSON 目录（最省流量）
 *   省略 --corpus    从 Sekai-World master DB + exmeaning 资源站拉取官方剧情后扫描
 *
 * 用法：
 *   node scripts/assets/build-background-names.mjs --corpus <scenario-dir> \
 *     --out src/host/assets/background-names.json
 *   node scripts/assets/build-background-names.mjs --episodes 120 \
 *     --out src/host/assets/background-names.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MASTER_BASE = 'https://sekai-world.github.io/sekai-master-db-diff'
const STORAGE_BASE = 'https://storage.exmeaning.com/sekai-{region}-assets'
const DEFAULT_OUT = 'src/host/assets/background-names.json'

/** 纯时间/日期类的 Telop 不是地点名。 */
const TIME_LIKE =
  /^(翌日|数日後|数時間後|その日|次の日|同日|翌朝|朝|昼|夜|夕方|[0-9０-９]+日目|.*後|.*前|.*時)$/
/** 星期/年末这类纯日期，以及官方占位符，不作为名字。 */
const DATE_LIKE = /^(土曜日|日曜日|月曜日|火曜日|水曜日|木曜日|金曜日|年末|年始|平日|休日)$/
const PLACEHOLDER = /^[?？]+$/

function parseArgs(argv) {
  const out = {
    corpus: '',
    episodes: 0,
    region: 'jp',
    out: DEFAULT_OUT,
    concurrency: 8,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--corpus') out.corpus = next()
    else if (arg === '--episodes') out.episodes = Number(next())
    else if (arg === '--region') out.region = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--concurrency') out.concurrency = Number(next())
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJson(url, { retries = 4 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'msst-background-names/1' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      return await res.json()
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError
}

/** 读取 scenario JSON 里某个背景被设置期间出现的 PlaceInfo/Telop 文本。 */
export function locationsOfScenario(scenario) {
  const pairs = []
  let current = String(scenario.FirstBackground || '')
  for (const snippet of scenario.Snippets || []) {
    if (Number(snippet.Action) !== 6) continue
    const effect = (scenario.SpecialEffectData || [])[snippet.ReferenceIndex] || {}
    const type = Number(effect.EffectType || 0)
    if (type === 7) {
      current = effect.StringValSub || effect.StringVal || current
      continue
    }
    // 8 = ScenarioTelop，18 = PlaceInfo；两者都是画面上的地点/时间标题。
    if (type !== 8 && type !== 18) continue
    const text = String(effect.StringVal || '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!current || !text || text.length > 24 || TIME_LIKE.test(text)) continue
    if (DATE_LIKE.test(text) || PLACEHOLDER.test(text)) continue
    pairs.push([current, text])
  }
  return pairs
}

/** 统计每个背景的地点名。 */
export function collectNames(scenarios) {
  const counts = new Map()
  for (const scenario of scenarios) {
    for (const [background, name] of locationsOfScenario(scenario)) {
      if (!counts.has(background)) counts.set(background, new Map())
      const perBackground = counts.get(background)
      perBackground.set(name, (perBackground.get(name) || 0) + 1)
    }
  }

  const backgrounds = {}
  for (const [id, names] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ranked = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    backgrounds[id] = {
      name: ranked[0][0],
      aliases: ranked
        .slice(1, 4)
        .filter(([, count]) => count >= 2)
        .map(([name]) => name)
    }
  }
  return backgrounds
}

function readCorpus(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
  return files.map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')))
}

async function fetchCorpus({ region, episodes, concurrency }) {
  const [events, eventStories] = await Promise.all([
    fetchJson(`${MASTER_BASE}/events.json`),
    fetchJson(`${MASTER_BASE}/eventStories.json`)
  ])
  const byEvent = new Map(eventStories.map((story) => [story.eventId, story]))
  const available = events.filter((event) => byEvent.has(event.id))
  const chosen = episodes > 0 ? available.slice(-episodes) : available
  const scenarios = []
  let next = 0
  const worker = async () => {
    while (next < chosen.length) {
      const event = chosen[next++]
      const asset = byEvent.get(event.id).assetbundleName
      for (let index = 1; index <= 8; index++) {
        const id = `${asset}_${String(index).padStart(2, '0')}`
        const url = `${STORAGE_BASE.replace('{region}', region)}/event_story/${asset}/scenario/${id}.json`
        try {
          scenarios.push(await fetchJson(url, { retries: 1 }))
        } catch {
          break
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return scenarios
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'usage: node scripts/assets/build-background-names.mjs [--corpus <dir>] [--episodes <n>] [--out <file>]'
    )
    return
  }
  const scenarios = args.corpus ? readCorpus(args.corpus) : await fetchCorpus(args)
  const backgrounds = collectNames(scenarios)
  const payload = {
    format: 'msst.background-names/1',
    generatedAt: new Date().toISOString(),
    source: args.corpus
      ? `official-stories:${scenarios.length}episodes`
      : `official-stories:${args.region}`,
    backgrounds
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  const named = Object.keys(backgrounds).length
  console.log(`wrote ${named} background names to ${args.out} (from ${scenarios.length} episodes)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
