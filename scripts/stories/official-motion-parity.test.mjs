/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 官方动作语义（用于锁定“动作在句首、剪辑长度决定切换观感”）：
 * - 29,057 条 TalkData 中 80.5% 带 Motions，其中 99.7% 只有 1 个；
 * - MotionChangeFrom 全为 1、TimingSyncValue 全为 0 —— 动作在台词开始时触发；
 * - motion3.json 不写 FadeInTime/FadeOutTime，SSE 的 Live2D runtime 用 body_motion_fade=0.5s；
 * - 01ichika 的 246 个 body motion 时长 1.0~3.97 秒，均值约 2.33 秒。
 *
 * 语料/模型不存在时跳过。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { BODY_MOTION_FADE_SECONDS } from '../../out-host/common/official/timing.js'

const CORPUS = process.env.MSS_CORPUS || 'D:/Users/桌面/mzkbot/msst-ai-lab/corpus/raw/jp'
const MOTIONS =
  process.env.MSS_MOTIONS || 'resources/models/01ichika_normal/01ichika_normal_3.0_f_t04/motions'
const hasCorpus = fs.existsSync(CORPUS)
const hasMotions = fs.existsSync(MOTIONS)

test(
  'official TalkData triggers one motion at the start of each line',
  { skip: !hasCorpus && `没有官方语料：${CORPUS}` },
  () => {
    let total = 0
    let withMotions = 0
    let single = 0
    let changeFromOne = 0
    let timingZero = 0
    for (const file of fs.readdirSync(CORPUS)) {
      if (!file.endsWith('.json')) continue
      const scenario = JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'))
      for (const talk of scenario.TalkData || []) {
        total++
        if (talk.Motions?.length) {
          withMotions++
          if (talk.Motions.length === 1) single++
          if (talk.Motions.every((motion) => Number(motion.TimingSyncValue) === 0)) timingZero++
        }
        if (Number(talk.MotionChangeFrom) === 1) changeFromOne++
      }
    }
    assert.ok(total >= 20_000, `官方 TalkData 样本太少：${total}`)
    assert.ok(withMotions / total > 0.75, `带动作比例 ${(withMotions / total).toFixed(3)}`)
    assert.ok(single / withMotions > 0.99, `单动作比例 ${(single / withMotions).toFixed(3)}`)
    assert.equal(changeFromOne, total, 'MotionChangeFrom 必须全部为 1')
    assert.equal(timingZero, withMotions, 'TimingSyncValue 必须全部为 0（句首）')
  }
)

test(
  'official body motions use the 0.5s game fade fallback and last 1-4s',
  { skip: !hasMotions && `没有模型动作目录：${MOTIONS}` },
  () => {
    assert.equal(BODY_MOTION_FADE_SECONDS, 0.5, '无 FadeInTime 时官方 body fade 为 0.5s')
    const durations = []
    for (const file of fs.readdirSync(MOTIONS)) {
      if (!file.startsWith('w-') || !file.endsWith('.motion3.json')) continue
      const motion = JSON.parse(fs.readFileSync(path.join(MOTIONS, file), 'utf8'))
      const meta = motion.Meta || {}
      assert.equal(meta.FadeInTime, undefined, `${file} 不应写 FadeInTime`)
      assert.equal(meta.FadeOutTime, undefined, `${file} 不应写 FadeOutTime`)
      assert.ok(Number(meta.Duration) > 0, `${file} 缺少 Duration`)
      durations.push(Number(meta.Duration))
    }
    assert.ok(durations.length >= 200, `动作样本太少：${durations.length}`)
    const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length
    assert.ok(mean > 1.5 && mean < 3.0, `body motion 平均 ${mean.toFixed(2)}s`)
    assert.ok(Math.min(...durations) >= 0.9, `最短 ${Math.min(...durations)}s`)
    assert.ok(Math.max(...durations) <= 4.2, `最长 ${Math.max(...durations)}s`)
  }
)
