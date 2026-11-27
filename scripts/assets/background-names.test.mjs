/**
 * 背景名索引：官方剧情的 PlaceInfo/Telop 地点文本 → 背景 id 的可读名。
 * 名字来源于官方舞台字幕（stage caption），只统计背景生效期间的文本。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectNames, locationsOfScenario } from '../../scripts/assets/build-background-names.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const scenario = (effects, first = 'bg_a000301') => ({
  FirstBackground: first,
  SpecialEffectData: effects,
  Snippets: effects.map((_effect, index) => ({ Action: 6, ReferenceIndex: index }))
})

test('pairs place-info text with the background active at that point and filters date/telop titles', () => {
  const data = scenario([
    { EffectType: 18, StringVal: '教室' },
    { EffectType: 7, StringValSub: 'bg_a000701' },
    { EffectType: 8, StringVal: '天台' },
    { EffectType: 8, StringVal: '翌日' },
    { EffectType: 8, StringVal: '文化祭当日' },
    { EffectType: 8, StringVal: '第二天 放学后' },
    { EffectType: 8, StringVal: '？？？' }
  ])
  assert.deepEqual(locationsOfScenario(data), [
    ['bg_a000301', '教室'],
    ['bg_a000701', '天台']
  ])
})

test('collects the most frequent name and keeps aliases', () => {
  const names = collectNames([
    scenario([{ EffectType: 18, StringVal: '教室' }]),
    scenario([{ EffectType: 18, StringVal: '教室' }]),
    scenario([{ EffectType: 18, StringVal: '２年Ｂ組' }])
  ])
  assert.equal(names.bg_a000301.name, '教室')
  assert.deepEqual(names.bg_a000301.aliases, [])
})

test('checked-in background name index is populated with rich Simplified Chinese metadata', () => {
  const file = path.join(root, 'src/host/assets/background-names.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.equal(data.format, 'msst.background-names/1')
  const backgrounds = Object.values(data.backgrounds ?? {})
  assert.ok(
    backgrounds.length >= 1300,
    `expected >=1300 named/classified backgrounds, got ${backgrounds.length}`
  )
  assert.equal(data.backgrounds.bg_white.name, '纯白过渡幕布')
  assert.equal(data.backgrounds.bg_white.category, '特效与纯色')
  assert.equal(data.backgrounds.bg_a000301.name, '神山高校 三年一班')
  assert.equal(data.backgrounds.bg_a000301.category, '校园')
  assert.equal(data.backgrounds.bg_a000301.indoor, '室内')
  assert.ok(
    ['白天', '黄昏', '夜晚', '深夜', '通用'].includes(data.backgrounds.bg_a000301.timeOfDay)
  )
  for (const entry of backgrounds) {
    assert.ok(entry.name && entry.name !== '？？？' && entry.name !== '文化祭当日')
    assert.ok(entry.category)
    assert.ok(['白天', '黄昏', '夜晚', '深夜', '通用'].includes(entry.timeOfDay))
    assert.ok(['室内', '室外'].includes(entry.indoor))
    assert.ok(Array.isArray(entry.tags) && entry.tags.length > 0)
  }

  // Daytime sky rooftop & base 01 daytime scenes must not be mislabeled 黄昏 by after-school dialogue
  assert.equal(data.backgrounds.bg_a002801.timeOfDay, '白天')
  assert.equal(data.backgrounds.bg_a000101.timeOfDay, '白天')
  assert.equal(data.backgrounds.bg_a000901.timeOfDay, '白天')
  assert.equal(data.backgrounds.bg_d001502.timeOfDay, '白天')
  for (const [id, entry] of Object.entries(data.backgrounds ?? {})) {
    if (id.startsWith('bg_h')) {
      assert.equal(entry.timeOfDay, '通用', `${id} online voice UI must not be tinted day/evening`)
    }
  }
})
