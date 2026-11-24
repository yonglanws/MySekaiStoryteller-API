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

const understanding = (overrides = {}) => ({
  explicitRequests: [],
  implicitSubtext: '',
  relationshipDynamic: '',
  emotionalArc: '',
  canonHooks: [],
  avoidList: [],
  ...overrides
})

test('lintDialogueFidelity flags explicit requests and canon hooks that never land in the dialogue', () => {
  const plan = {
    cast: [
      { modelId: 1, name: '瑞希', fullName: '晓山瑞希', path: '', role: '' },
      { modelId: 2, name: '真冬', fullName: '朝比奈真冬', path: '', role: '' }
    ],
    understanding: understanding({
      explicitRequests: ['瑞希把伞借给真冬'],
      canonHooks: ['神山高校天台']
    })
  }
  const missed = lintDialogueFidelity(
    {
      title: '漏诉求',
      lines: [
        { id: 'l1', speaker: '瑞希', content: '今天也一起练习吧。' },
        { id: 'l2', speaker: '真冬', content: '嗯，先调音。' }
      ]
    },
    plan
  )
  const gaps = missed.issues.filter((issue) => issue.code === 'prompt_coverage_gap')
  assert.equal(gaps.length, 2, 'one request gap + one aggregated canon-hook gap')
  assert.ok(gaps.some((issue) => issue.message.includes('瑞希把伞借给真冬')))
  assert.ok(missed.shouldPolish)

  const covered = lintDialogueFidelity(
    {
      title: '已落地',
      lines: [
        { id: 'l1', speaker: '瑞希', content: '伞我借你，明天在天台还我就行。' },
        { id: 'l2', speaker: '真冬', content: '……嗯。' }
      ]
    },
    plan
  )
  assert.equal(
    covered.issues.filter((issue) => issue.code === 'prompt_coverage_gap').length,
    0,
    'mentions of the request keywords clear the gap'
  )
})

test('lintDialogueFidelity flags a six-line lecture wall and duo speaker imbalance', () => {
  const wall = lintDialogueFidelity({
    title: '说教墙',
    lines: Array.from({ length: 6 }, (_, index) => ({
      id: `l${index + 1}`,
      speaker: index % 2 === 0 ? '瑞希' : '绘名',
      content: `我觉得这件事情其实应该从头到尾再认真想一遍才不会后悔吧${index}`
    }))
  })
  assert.ok(wall.issues.some((issue) => issue.code === 'monologue_overload'))

  const imbalance = lintDialogueFidelity({
    title: '失衡',
    lines: Array.from({ length: 12 }, (_, index) => ({
      id: `l${index + 1}`,
      speaker: index < 10 ? '瑞希' : '绘名',
      content: index < 10 ? '嗯。' : '……你也说够了吧。'
    }))
  })
  assert.ok(imbalance.issues.some((issue) => issue.code === 'speaker_imbalance'))
})

test('lintDialogueFidelity flags templated sentence openers', () => {
  const report = lintDialogueFidelity({
    title: '模板开头',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '其实我昨天就想说了。' },
      { id: 'l2', speaker: '绘名', content: '嗯？' },
      { id: 'l3', speaker: '瑞希', content: '其实那幅画我偷偷改过。' },
      { id: 'l4', speaker: '绘名', content: '……' },
      { id: 'l5', speaker: '瑞希', content: '其实你不用勉强自己。' },
      { id: 'l6', speaker: '绘名', content: '我知道。' }
    ]
  })
  const openers = report.issues.filter((issue) => issue.code === 'repetitive_opener')
  assert.equal(openers.length, 1)
  assert.equal(openers[0].lineId, 'l5', 'flag the last repetition')
})

test('lintDialogueFidelity catches expanded AI cliches and surname misaddress', () => {
  const plan = {
    cast: [
      { modelId: 1, name: '瑞希', fullName: '晓山瑞希', path: '', role: '' },
      { modelId: 2, name: '绘名', fullName: '东云绘名', path: '', role: '' }
    ],
    pairwiseAddress: [{ from: '瑞希', to: '绘名', zh: '绘绘' }]
  }
  const report = lintDialogueFidelity(
    {
      title: '套话',
      lines: [
        { id: 'l1', speaker: '瑞希', content: '经过今天的练习，让我们更加明白彼此了。' },
        { id: 'l2', speaker: '绘名', content: '……' },
        { id: 'l3', speaker: '瑞希', content: '东云，你今天怎么这么安静？' },
        { id: 'l4', speaker: '绘名', content: '心里暖暖的，有你在真好。' }
      ]
    },
    plan
  )
  const codes = report.issues.map((issue) => issue.code)
  assert.ok(codes.includes('therapy_cliche'))
  assert.ok(
    report.issues.filter((issue) => issue.code === 'therapy_cliche').length >= 2,
    'both new cliche lines are flagged'
  )
  const mismatch = report.issues.find((issue) => issue.code === 'address_mismatch')
  assert.ok(mismatch)
  assert.equal(mismatch.lineId, 'l3')
  assert.ok(mismatch.message.includes('姓氏「东云」'))
})

test('buildDialoguePolishPrompt carries the user prompt, persona voice baseline, motif anchors and canon voice samples', () => {
  const plan = {
    title: '雨天',
    event: '便利店门口等雨停',
    logline: '',
    outline: [],
    cast: [
      { modelId: 1, name: '瑞希', fullName: '晓山瑞希', path: '', role: '' },
      { modelId: 2, name: '绘名', fullName: '东云绘名', path: '', role: '' }
    ],
    background: 'bg_room.jpg',
    pairwiseAddress: [{ from: '瑞希', to: '绘名', zh: '绘绘' }],
    understanding: understanding({
      explicitRequests: ['瑞希把伞借给绘名'],
      turningPoint: '看见绘名抱着画稿淋湿，瑞希收起玩笑语气',
      openingMotif: '便利店门口的塑料伞架',
      closingCallback: '绘名把伞收好，说明天再还'
    })
  }
  const dialogue = {
    title: '雨天',
    lines: [
      { id: 'l1', speaker: '瑞希', content: '其实我一直想说，谢谢你总是这么温柔。' },
      { id: 'l2', speaker: '绘名', content: '……少贫嘴了。' }
    ]
  }
  const personas = [
    {
      name: '晓山瑞希',
      prompt: '瑞希说话轻快，喜欢用拖长的语气词逗人，被认真回应时会突然小声。',
      aliases: ['mizuki'],
      group: '25 时',
      source: ''
    }
  ]
  const view = {
    modelById: (id) =>
      id === 1 ? { id: 1, name: '晓山瑞希', shortName: '瑞希', path: '' } : null
  }
  const ragContext = {
    sections: { dialogueVoice: [{ text: '瑞希：诶——？\n你又在便利店站着发呆啊。' }] }
  }
  const report = lintDialogueFidelity(dialogue, plan)
  const prompt = buildDialoguePolishPrompt(plan, dialogue, report.issues, {
    scene: '雨天放学后，瑞希和绘名在便利店门口等雨停，瑞希把伞塞给绘名',
    view,
    personas,
    ragContext
  })
  assert.ok(prompt.user.includes('## 用户原始需求'))
  assert.ok(prompt.user.includes('瑞希把伞塞给绘名'), 'verbatim user prompt must reach the polish stage')
  assert.ok(prompt.user.includes('## 说话者口吻基线'))
  assert.ok(prompt.user.includes('瑞希说话轻快'), 'persona voice baseline for the flagged speaker')
  assert.ok(prompt.user.includes('便利店门口的塑料伞架'), 'opening motif anchor')
  assert.ok(prompt.user.includes('明天再还'), 'closing callback anchor')
  assert.ok(prompt.user.includes('## 官方口吻参照'))
  assert.ok(prompt.user.includes('诶——？'))
  assert.ok(prompt.user.includes('目标句 l1'))
  assert.ok(!prompt.user.includes('目标句 l2'))
  assert.ok(prompt.system.includes('保持原意'))
})
