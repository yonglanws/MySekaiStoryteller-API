/**
 * 背景名索引：官方剧情的 PlaceInfo/Telop 地点文本 → 背景 id 的可读名。
 * 名字来源与 ournotes-player 的 stage caption 一致，只统计背景生效期间的文本。
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

test('pairs place-info text with the background active at that point', () => {
  const data = scenario([
    { EffectType: 18, StringVal: '教室' },
    { EffectType: 7, StringValSub: 'bg_a000701' },
    { EffectType: 8, StringVal: '屋上' },
    { EffectType: 8, StringVal: '翌日' },
    { EffectType: 8, StringVal: '？？？' }
  ])
  assert.deepEqual(locationsOfScenario(data), [
    ['bg_a000301', '教室'],
    ['bg_a000701', '屋上']
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

test('checked-in background name index is populated', () => {
  const file = path.join(root, 'src/host/assets/background-names.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.equal(data.format, 'msst.background-names/1')
  const backgrounds = Object.values(data.backgrounds ?? {})
  assert.ok(
    backgrounds.length >= 100,
    `expected >=100 named backgrounds, got ${backgrounds.length}`
  )
  assert.equal(data.backgrounds.bg_a000301.name, '神山高校 ３年Ａ組')
  for (const entry of backgrounds) {
    assert.ok(entry.name && entry.name !== '？？？')
  }
})
