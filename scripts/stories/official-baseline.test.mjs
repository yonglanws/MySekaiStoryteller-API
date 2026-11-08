/**
 * 官方剧情基线的回归测试。
 *
 * 语料在仓库外（默认 D:/Users/桌面/mzkbot/msst-ai-lab/corpus，可用 MSS_CORPUS 覆盖）。
 * 找不到语料时跳过，不阻塞普通 npm test；找到时断言我们据以改提示词的关键数字没有漂移。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { aggregate, officialToLines, summarize, windowsOf } from './story-metrics-lib.mjs'

const CORPUS = process.env.MSS_CORPUS || 'D:/Users/桌面/mzkbot/msst-ai-lab/corpus'
const hasCorpus = fs.existsSync(path.join(CORPUS, 'index.json'))

test(
  'official 3-minute two-speaker windows keep their measured shape',
  { skip: !hasCorpus && '官方语料不存在（设置 MSS_CORPUS 指向 fetch-official-corpus 的输出）' },
  () => {
    const index = JSON.parse(fs.readFileSync(path.join(CORPUS, 'index.json'), 'utf8'))
    const byScenario = new Map(
      index.episodes.map((entry) => [`${entry.region}/${entry.scenarioId}`, entry])
    )
    const windows = []
    for (const entry of index.episodes.filter((item) => item.region === 'jp')) {
      const jp = JSON.parse(fs.readFileSync(entry.path, 'utf8'))
      const cnEntry = byScenario.get(`cn/${entry.scenarioId}`)
      const cn =
        cnEntry && fs.existsSync(cnEntry.path)
          ? JSON.parse(fs.readFileSync(cnEntry.path, 'utf8'))
          : null
      const lines = officialToLines(jp, cn)
      for (const window of windowsOf(lines, 40)) {
        const speakers = new Set(window.map((line) => line.speakerId))
        const backgrounds = new Set(window.map((line) => line.background))
        if (speakers.size <= 2 && backgrounds.size <= 2) windows.push(window)
      }
    }
    assert.ok(windows.length >= 30, `expected >=30 windows, got ${windows.length}`)
    const result = aggregate(windows.map((window) => summarize(window)))

    // 这些是提示词与 compose 的依据；漂移了就要重新核对提示词。
    assert.ok(result.text.charsMean >= 17 && result.text.charsMean <= 20)
    assert.ok(result.text.charsP90 >= 30 && result.text.charsP90 <= 38)
    assert.ok(result.text.longShare >= 0.15 && result.text.longShare <= 0.35)
    assert.ok(result.text.shortShare >= 0.12 && result.text.shortShare <= 0.25)
    assert.ok(result.turns.speakerRunMean >= 2.0 && result.turns.speakerRunMean <= 2.8)
    assert.ok(result.acting.speakerActionsMean >= 0.7 && result.acting.speakerActionsMean <= 1.0)
    assert.ok(result.acting.noActionShare >= 0.1 && result.acting.noActionShare <= 0.3)
    assert.ok(result.stage.stageMean >= 0.9 && result.stage.stageMean <= 1.3)
    assert.ok(result.stage.soloShare >= 0.6 && result.stage.soloShare <= 0.9)
    assert.ok(result.stage.appearsPer40 >= 10 && result.stage.appearsPer40 <= 25)
    assert.ok(result.stage.bgChangesPer40 >= 0.5 && result.stage.bgChangesPer40 <= 2)
    assert.ok(result.emotion.changesPer40 >= 10 && result.emotion.changesPer40 <= 25)
  }
)
