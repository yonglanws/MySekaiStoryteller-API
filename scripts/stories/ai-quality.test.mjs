/**
 * AI 生成质量回归：读取 ai-eval 的 report.json，断言聚合指标落在“接近官方”的区间。
 *
 * 报告默认读 D:/Users/桌面/mzkbot/msst-ai-lab/runs/phase3a-thinkoff/report.json，
 * 可用 MSS_EVAL_REPORT 指向任意一次 ai-eval 输出。没有报告时跳过。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const REPORT =
  process.env.MSS_EVAL_REPORT || 'D:/Users/桌面/mzkbot/msst-ai-lab/runs/phase20-mid/report.json'
const hasReport = fs.existsSync(REPORT)

const inRange = (value, min, max, label) =>
  assert.ok(value >= min && value <= max, `${label}=${value} 不在 ${min}~${max} 区间`)

test(
  'AI generated scenes stay close to the official 3-minute rhythm',
  { skip: !hasReport && '没有 ai-eval 报告（先跑 scripts/stories/ai-eval.mjs）' },
  () => {
    const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
    const aggregate = report.aggregate
    assert.ok(aggregate, 'report 缺少 aggregate')
    assert.ok(report.results.length >= 4, '至少需要 4 个场景的报告')

    for (const result of report.results) {
      assert.ok(!result.error, `${result.label} 生成失败：${result.error}`)
      assert.ok(result.summary, `${result.label} 缺少 summary`)
      const charsTotal =
        result.summary.text.charsTotal ?? Math.round(result.summary.text.charsMean * result.lines)
      assert.ok(result.lines >= 28, `${result.label} 只有 ${result.lines} 句`)
      assert.ok(charsTotal >= 400, `${result.label} 只有 ${charsTotal} 字`)
    }

    const charsTotalMean =
      aggregate.text.charsTotalMean ??
      Math.round(
        report.results.reduce(
          (sum, result) =>
            sum +
            (result.summary.text.charsTotal ??
              Math.round(result.summary.text.charsMean * result.lines)),
          0
        ) / report.results.length
      )

    inRange(aggregate.linesMean, 28, 50, 'linesMean')
    inRange(aggregate.estimatedSecondsMean, 130, 230, 'estimatedSecondsMean')
    inRange(aggregate.text.charsMean, 16, 22, 'charsMean')
    inRange(charsTotalMean, 540, 900, 'charsTotalMean')
    inRange(aggregate.text.longShare, 0.15, 0.42, 'longShare')
    inRange(aggregate.text.shortShare, 0.06, 0.3, 'shortShare')
    inRange(aggregate.text.ellipsisShare, 0.25, 0.65, 'ellipsisShare')
    inRange(aggregate.text.questionShare, 0.08, 0.35, 'questionShare')

    inRange(aggregate.turns.speakerRunMean, 1.6, 2.8, 'speakerRunMean')
    inRange(aggregate.turns.soloRunShare, 0.2, 0.7, 'soloRunShare')

    inRange(aggregate.acting.speakerActionsMean, 0.7, 1.1, 'speakerActionsMean')
    inRange(aggregate.acting.noActionShare, 0.12, 0.3, 'noActionShare')
    inRange(aggregate.acting.listenerShare, 0.03, 0.25, 'listenerShare')

    // 情绪刻意比官方表情级更稳：6~10 次/40 句以内，而不是逐句跳。
    inRange(aggregate.emotion.changesPer40, 1.5, 12, 'emotionChangesPer40')
    inRange(aggregate.emotion.runMean, 3, 16, 'emotionRunMean')

    // 双人戏现在整场同场（Left/Right），不再按发言段反复 Clear/Appear；
    // 单人戏仍允许 Center。旧报告（逐段上下场）也落在这个宽区间里。
    inRange(aggregate.stage.stageMean, 1.05, 2.1, 'stageMean')
    inRange(aggregate.stage.soloShare, 0, 0.95, 'soloShare')
    inRange(aggregate.stage.appearsPer40, 1, 30, 'appearsPer40')
    inRange(aggregate.stage.clearsPer40, 1, 30, 'clearsPer40')
    inRange(aggregate.stage.bgChangesPer40, 0.5, 2.2, 'bgChangesPer40')

    // 如果这次评测的每个场景都是双人同场，入场/退场必须各只有开场/结尾一次
    // （40 句折算 ≤4 次），防止 presence 又退回逐段切人。
    const allDuo = report.results.every(
      (result) =>
        result.summary?.stage?.stageMean >= 1.9 && result.summary?.stage?.soloShare <= 0.05
    )
    if (allDuo) {
      inRange(aggregate.stage.appearsPer40, 1, 4, 'duo appearsPer40')
      inRange(aggregate.stage.clearsPer40, 1, 4, 'duo clearsPer40')
    }
    // 官方约 1.5 次/40 句；低于 1.0 说明第二首 BGM 没有生效（只剩开场一条）。
    inRange(aggregate.stage.bgmChangesPer40, 1.0, 2.4, 'bgmChangesPer40')
  }
)
