import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lintDialogueFidelity } from '../../out-host/host/ai/dialogueLinter.js'
import { applyDialoguePolish, buildDialoguePolishPrompt } from '../../out-host/host/ai/staged.js'

test('lintDialogueFidelity passes clean official-style PJSK dialogue without triggering polish', () => {
  const dialogue = {
    title: '放学后',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '绘绘——！\n等你好久啦！' },
      { id: 'l2', speaker: '绘名', content: '……吵死了。' },
      { id: 'l3', speaker: '瑞希', content: '诶，黑眼圈这么重，昨晚又熬夜改线稿了？' },
      { id: 'l4', speaker: '绘名', content: '要你管啊。\n……快走吧，便利店的新品要卖光了。' }
    ]
  }
  const report = lintDialogueFidelity(dialogue, {
    pairwiseAddress: [{ from: '瑞希', to: '绘名', zh: '绘绘', ja: 'えななん' }]
  })
  assert.equal(report.issues.length, 0)
  assert.equal(report.shouldPolish, false)
})

test('lintDialogueFidelity flags therapy cliches, stage-direction leaks, moralizing endings, and address mismatches', () => {
  const dialogue = {
    title: '套路样本',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '绘名，其实我一直想说，谢谢你总是这么温柔。' },
      { id: 'l2', speaker: '绘名', content: '（叹气）她转过头看着窗外。' },
      { id: 'l3', speaker: '瑞希', content: '不管发生什么我们都会一直在一起！' },
      { id: 'l4', speaker: '绘名', content: '今天真是难忘的一天，只要大家在一起一定会越来越好。' }
    ]
  }
  const report = lintDialogueFidelity(dialogue, {
    pairwiseAddress: [{ from: '瑞希', to: '绘名', zh: '绘绘', ja: 'えななん' }]
  })
  const codes = new Set(report.issues.map((i) => i.code))
  assert.ok(codes.has('therapy_cliche'))
  assert.ok(codes.has('stage_direction_leak'))
  assert.ok(codes.has('moralizing_ending'))
  assert.ok(codes.has('address_mismatch'))
  assert.equal(report.shouldPolish, true)
  assert.ok(report.flaggedLineIds.includes('l1'))
  assert.ok(report.flaggedLineIds.includes('l2'))
  assert.ok(report.flaggedLineIds.includes('l4'))
})

test('lintDialogueFidelity flags uniform cadence and exclamation overload', () => {
  const dialogue = {
    title: '节奏测试',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '今天放学后我们一起去练习吧！' },
      { id: 'l2', speaker: '绘名', content: '我把昨天画好的草稿带过来了！' },
      { id: 'l3', speaker: '瑞希', content: '那我们顺便去买一点小零食吧！' },
      { id: 'l4', speaker: '绘名', content: '可是我还要先去社团拿一下东西。' },
      { id: 'l5', speaker: '瑞希', content: '没关系我可以在门口稍微等一下。' },
      { id: 'l6', speaker: '绘名', content: '那好吧我就快点去把东西拿过来。' }
    ]
  }
  const report = lintDialogueFidelity(dialogue)
  const codes = new Set(report.issues.map((i) => i.code))
  assert.ok(codes.has('uniform_cadence'))
  assert.ok(codes.has('exclamation_overload'))
  assert.equal(report.shouldPolish, true)
})

test('buildDialoguePolishPrompt and applyDialoguePolish perform surgical line-level rewrites only on flagged IDs', () => {
  const plan = {
    title: '测试',
    event: '天台聊天',
    logline: '',
    outline: [],
    cast: [
      { modelId: 1, name: '瑞希', fullName: '晓山瑞希', path: '', role: '' },
      { modelId: 2, name: '绘名', fullName: '东云绘名', path: '', role: '' }
    ],
    background: 'bg_room.jpg',
    pairwiseAddress: [{ from: '瑞希', to: '绘名', zh: '绘绘', ja: 'えななん' }]
  }
  const dialogue = {
    title: '测试',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '其实我一直想说，谢谢你总是这么温柔。', pauseBefore: 1.0 },
      { id: 'l2', speaker: '绘名', content: '……少贫嘴了。' }
    ]
  }
  const report = lintDialogueFidelity(dialogue, plan)
  const prompt = buildDialoguePolishPrompt(plan, dialogue, report.issues)
  assert.ok(prompt.system.includes('dialogue-polish'))
  assert.ok(prompt.user.includes('目标句 l1'))
  assert.ok(!prompt.user.includes('目标句 l2'))

  const polished = applyDialoguePolish(
    dialogue,
    {
      replacements: [
        { id: 'l1', content: '绘绘，刚才那杯奶茶其实挺好喝的。' },
        { id: 'l2', content: '不应该被改写的句子' }
      ]
    },
    new Set(report.flaggedLineIds)
  )
  assert.equal(polished.lines.length, 2)
  assert.equal(polished.lines[0].content, '绘绘，刚才那杯奶茶其实挺好喝的。')
  assert.equal(polished.lines[0].pauseBefore, 1.0, 'metadata preserved on polished line')
  assert.equal(polished.lines[1].content, '……少贫嘴了。', 'unflagged line must never be modified')
})
