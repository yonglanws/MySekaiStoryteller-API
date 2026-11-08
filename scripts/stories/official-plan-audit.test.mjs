/**
 * 官方剧情语料批量回归。
 *
 * 语料在仓库外（默认 `D:/Users/桌面/mzkbot/msst-ai-lab/corpus`）。存在时逐集跑
 * `calculateTimeline + bakeStoryPlan`，把 328 集 / 10 万级 snippets 的真实官方数据
 * 当作回归输入；不存在时跳过，不影响普通 clone。
 *
 * 锁死的不是资源路径，而是时序语义：
 * - Talk 打字只数可见字符（换行不占 4 帧），无语音 +120 帧；
 * - Talk 动作 cue 在句首；
 * - Appear 1+6 帧、Clear 原地 15 帧 / 滑动 fade=move-6、Move 20/30/45 帧；
 * - WhiteIn 0.1s、Wipe 0.4s、Camera 0s 等精确时长不被 500ms 下限拉长；
 * - plan 与 timeline 逐条对齐。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { auditCorpus, listCorpusEpisodes } from './official-plan-audit.mjs'

const corpusRoot = process.env.MSST_CORPUS_ROOT || 'D:/Users/桌面/mzkbot/msst-ai-lab/corpus'
const indexPath = path.join(corpusRoot, 'index.json')
const hasCorpus = fs.existsSync(indexPath)

test(
  'official JP scenario corpus maps to a frame plan with zero timing failures',
  { skip: hasCorpus ? false : `官方语料不存在：${corpusRoot}` },
  () => {
    const episodes = listCorpusEpisodes(corpusRoot)
    assert.ok(episodes.length >= 300, `日服集数异常：${episodes.length}`)

    const report = auditCorpus(corpusRoot)
    assert.equal(report.episodes, episodes.length)
    assert.deepEqual(report.failures, [], report.failures.slice(0, 10).join('\n'))

    // 语料规模锚点：数量级变化说明映射丢了 Action 或 ReferenceIndex 解析错了。
    assert.ok(report.totals.snippets > 100_000, `snippets=${report.totals.snippets}`)
    assert.ok(report.totals.talks > 28_000, `talks=${report.totals.talks}`)
    assert.ok(report.totals.appears > 20_000, `appears=${report.totals.appears}`)
    assert.ok(report.totals.clears > 20_000, `clears=${report.totals.clears}`)
    assert.ok(report.totals.moves > 4_000, `moves=${report.totals.moves}`)
    assert.ok(report.totals.motions > 36_000, `motions=${report.totals.motions}`)
    assert.ok(report.totals.layoutModes > 300, `layoutModes=${report.totals.layoutModes}`)
    assert.ok(report.totals.actions > 23_000, `actions=${report.totals.actions}`)
    assert.ok(report.totals.nonWait > 27_000, `nonWait=${report.totals.nonWait}`)

    // 每集都必须真的产出 plan；空 plan 的集数不能混过去。
    assert.equal(report.episodeSummaries.filter((episode) => episode.snippets === 0).length, 0)
  }
)
