#!/usr/bin/env node
/**
 * 官方剧情基线：把语料库里的每一集拆成指标，重点看 40 句（约 3 分钟）的双人窗口。
 *
 * 用法：
 *   node scripts/stories/official-metrics.mjs \
 *     --corpus D:/msst-lab/corpus --out D:/msst-lab/official-baseline.json
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  EMOTION_LABELS,
  aggregate,
  officialToLines,
  percentile,
  printAggregate,
  summarize,
  windowsOf
} from './story-metrics-lib.mjs'

function parseArgs(argv) {
  const out = { corpus: '', out: '', window: 40 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--corpus') out.corpus = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--window') out.window = Number(next())
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!out.corpus) throw new Error('--corpus is required')
  return out
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function emotionTransitionMatrix(episodes) {
  const matrix = Object.fromEntries(
    EMOTION_LABELS.map((from) => [from, Object.fromEntries(EMOTION_LABELS.map((to) => [to, 0]))])
  )
  for (const lines of episodes) {
    for (let index = 1; index < lines.length; index++) {
      const from = lines[index - 1].emotion
      const to = lines[index].emotion
      if (matrix[from] && matrix[from][to] !== undefined) matrix[from][to] += 1
    }
  }
  return matrix
}

function emotionRunsPerSpeaker(episodes) {
  const runs = []
  for (const lines of episodes) {
    const bySpeaker = new Map()
    for (const line of lines) {
      if (!bySpeaker.has(line.speaker)) bySpeaker.set(line.speaker, [])
      bySpeaker.get(line.speaker).push(line.emotion)
    }
    for (const emotions of bySpeaker.values()) {
      let previous = ''
      let count = 0
      for (const emotion of emotions) {
        if (emotion === previous) count += 1
        else {
          if (previous) runs.push(count)
          previous = emotion
          count = 1
        }
      }
      if (previous) runs.push(count)
    }
  }
  return runs
}

function stageOpening(episodes) {
  const patterns = []
  for (const lines of episodes) {
    const head = lines.slice(0, 12)
    const sizes = head.map((line) => line.stageIds.length)
    const firstTwo = sizes.findIndex((size) => size >= 2)
    patterns.push({ sizes, firstTwo })
  }
  return patterns
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const corpus = path.resolve(args.corpus)
  const index = readJson(path.join(corpus, 'index.json'))
  const byScenario = new Map()
  for (const entry of index.episodes) byScenario.set(`${entry.region}/${entry.scenarioId}`, entry)

  const episodes = []
  const episodeSummaries = []
  const windows = []
  const windowMeta = []
  const nightcordWindows = []
  const failures = []

  for (const event of index.events) {
    const entries = index.episodes.filter(
      (entry) => entry.eventId === event.id && entry.region === 'jp'
    )
    for (const entry of entries) {
      const jpFile = entry.path
      if (!fs.existsSync(jpFile)) continue
      const cnEntry = byScenario.get(`cn/${entry.scenarioId}`)
      let cn = null
      if (cnEntry && fs.existsSync(cnEntry.path)) {
        try {
          cn = readJson(cnEntry.path)
        } catch {
          cn = null
        }
      }
      try {
        const lines = officialToLines(readJson(jpFile), cn)
        if (lines.length < 10) continue
        episodes.push({ ...entry, lines })
        episodeSummaries.push(summarize(lines))
        for (const window of windowsOf(lines, args.window)) {
          const speakers = new Set(window.map((line) => line.speakerId))
          const backgrounds = new Set(window.map((line) => line.background))
          if (speakers.size > 2 || backgrounds.size > 2) continue
          windows.push(window)
          const summary = summarize(window)
          windowMeta.push({
            eventId: entry.eventId,
            eventName: entry.eventName,
            unit: entry.eventUnit,
            episodeNo: entry.episodeNo,
            title: entry.title,
            scenarioId: entry.scenarioId,
            speakers: [...speakers],
            summary
          })
          if (event.unit === 'school_refusal') nightcordWindows.push(window)
        }
      } catch (error) {
        failures.push({ scenarioId: entry.scenarioId, error: String(error) })
      }
    }
  }

  const windowSummaries = windows.map((window) => summarize(window))
  const all = aggregate(windowSummaries)
  const nightcord = nightcordWindows.length
    ? aggregate(nightcordWindows.map((w) => summarize(w)))
    : null

  const transitions = emotionTransitionMatrix(windows)
  const runs = emotionRunsPerSpeaker(windows)
  const runCounts = {}
  for (const run of runs) runCounts[run] = (runCounts[run] || 0) + 1
  const runTotal = runs.length || 1

  const openings = stageOpening(windows)
  const firstTwo = openings.map((pattern) => pattern.firstTwo).filter((value) => value >= 0)
  const openingHistogram = {}
  for (const value of firstTwo) openingHistogram[value] = (openingHistogram[value] || 0) + 1

  const actionDistribution = [0, 1, 2, 3, 4, 5].map((count) => ({
    count,
    share: Number(
      (
        windowSummaries.filter((summary) => summary.acting.speakerActionsMean >= count).length /
        Math.max(1, windowSummaries.length)
      ).toFixed(3)
    )
  }))

  const report = {
    generatedAt: new Date().toISOString(),
    corpus,
    windowSize: args.window,
    events: index.events.length,
    episodes: episodes.length,
    windows: windows.length,
    failures,
    all,
    nightcord,
    episodeAggregate: aggregate(episodeSummaries),
    emotionTransitions: transitions,
    emotionRunHistogram: Object.fromEntries(
      Object.entries(runCounts)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([key, value]) => [key, Number((value / runTotal).toFixed(3))])
    ),
    emotionRunP50: percentile(runs, 0.5),
    emotionRunP90: percentile(runs, 0.9),
    opening: {
      secondCharacterEnterLineHistogram: openingHistogram,
      soloOpeningShare: Number(
        (
          openings.filter((pattern) => pattern.firstTwo !== 0).length / Math.max(1, openings.length)
        ).toFixed(3)
      )
    },
    windowQuality: {
      speakerActionsMeanP50: Number(
        percentile(
          windowSummaries.map((summary) => summary.acting.speakerActionsMean),
          0.5
        ).toFixed(2)
      ),
      emotionChangesP50: Number(
        percentile(
          windowSummaries.map((summary) => summary.emotion.changesPer40),
          0.5
        ).toFixed(2)
      ),
      emotionChangesP10: Number(
        percentile(
          windowSummaries.map((summary) => summary.emotion.changesPer40),
          0.1
        ).toFixed(2)
      ),
      emotionChangesP90: Number(
        percentile(
          windowSummaries.map((summary) => summary.emotion.changesPer40),
          0.9
        ).toFixed(2)
      ),
      listenerShareP50: Number(
        percentile(
          windowSummaries.map((summary) => summary.acting.listenerShare),
          0.5
        ).toFixed(3)
      ),
      lineCharsP50: Number(
        percentile(
          windowSummaries.map((summary) => summary.text.charsMean),
          0.5
        ).toFixed(2)
      )
    },
    samples: windowMeta.slice(0, 5).map((meta) => ({
      scenarioId: meta.scenarioId,
      speakers: meta.speakers,
      summary: meta.summary
    }))
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2))
  }

  console.log(
    `官方基线：events=${report.events} episodes=${report.episodes} windows=${report.windows} failures=${failures.length}`
  )
  printAggregate('ALL 40-line two-speaker windows', all)
  if (nightcord) printAggregate('Nightcord windows', nightcord)
  printAggregate('Whole episodes', report.episodeAggregate)
  console.log('\nemotion run histogram', JSON.stringify(report.emotionRunHistogram))
  console.log('emotion run p50/p90', report.emotionRunP50, report.emotionRunP90)
  console.log('opening second character enters at line', JSON.stringify(openingHistogram))
  console.log('quality percentiles', JSON.stringify(report.windowQuality))
  console.log('\nemotion transitions (rows=from)')
  for (const from of EMOTION_LABELS) {
    const row = transitions[from]
    const total = Object.values(row).reduce((sum, value) => sum + value, 0)
    console.log(
      from,
      EMOTION_LABELS.map(
        (to) => `${to}:${((row[to] / Math.max(1, total)) * 100).toFixed(1)}%`
      ).join(' ')
    )
  }
  if (args.out) console.log(`\nreport=${path.resolve(args.out)}`)
}

main()
