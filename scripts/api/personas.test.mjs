import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BUILTIN_PERSONA_DIR,
  loadHostConfig,
  resolveBuiltinPersonaDir
} from '../../out-host/host/config.js'
import {
  CANONICAL_UNITS,
  dialoguePersonaPrompt,
  loadPersonas,
  personaFor
} from '../../out-host/host/ai/personas.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUILTIN_PERSONA_DIR = path.join(REPO_ROOT, 'personas', 'pjsk')

const MANAGED_ENV_KEYS = ['MSS_CONFIG_PATH', 'MSS_RESOURCE_DIR', 'MSS_LLM_PERSONA_DIRS']

function withIsolatedEnv(t, yamlContent = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-personas-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const prev = new Map(MANAGED_ENV_KEYS.map((k) => [k, process.env[k]]))
  t.after(() => {
    for (const k of MANAGED_ENV_KEYS) {
      const val = prev.get(k)
      if (val === undefined) delete process.env[k]
      else process.env[k] = val
    }
  })

  for (const k of MANAGED_ENV_KEYS) {
    delete process.env[k]
  }

  const configPath = path.join(dir, 'config.yaml')
  if (yamlContent !== null) {
    fs.writeFileSync(configPath, yamlContent, 'utf8')
  }
  process.env.MSS_CONFIG_PATH = configPath
  process.env.MSS_RESOURCE_DIR = path.join(dir, 'resources')
  return { dir, configPath }
}

function collectFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

test('built-in personas/pjsk contains 58 clean UTF-8 LF markdown files with zero secrets or local paths', () => {
  assert.equal(DEFAULT_BUILTIN_PERSONA_DIR, 'personas/pjsk')
  assert.equal(resolveBuiltinPersonaDir(REPO_ROOT), BUILTIN_PERSONA_DIR)
  assert.ok(fs.existsSync(BUILTIN_PERSONA_DIR), 'personas/pjsk must exist in repository')

  const files = collectFiles(BUILTIN_PERSONA_DIR)
  assert.equal(files.length, 58, `expected 58 persona files, found ${files.length}`)

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const forbiddenPatterns = [
    { name: 'Windows drive path', re: /[A-Za-z]:\\(?:Users|Program|Windows|桌面)/i },
    { name: 'personal desktop path', re: /[\\/]桌面[\\/]/ },
    { name: 'Unix home/NAS path', re: /\/(?:Users|home|vol1)\/[A-Za-z0-9_-]+/ },
    { name: 'RFC1918 private IP', re: /\b(?:192\.168|10\.\d+)\.\d+\.\d+\b/ },
    { name: 'API key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
    { name: 'internal bot workspace name', re: /mzkbot/i }
  ]

  for (const file of files) {
    assert.ok(file.endsWith('.md'), `expected .md file: ${file}`)
    const raw = fs.readFileSync(file)
    assert.equal(
      raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
      false,
      `file must not have UTF-8 BOM: ${path.relative(REPO_ROOT, file)}`
    )
    assert.equal(
      raw.includes(0x0d),
      false,
      `file must use LF line endings: ${path.relative(REPO_ROOT, file)}`
    )
    const text = decoder.decode(raw)
    for (const { name, re } of forbiddenPatterns) {
      assert.doesNotMatch(text, re, `${path.relative(REPO_ROOT, file)} must not contain ${name}`)
    }
  }
})

test('default loadHostConfig automatically discovers and indexes all 58 built-in PJSK personas', (t) => {
  withIsolatedEnv(t, null)

  const cfg = loadHostConfig()
  assert.deepEqual(cfg.llm.personaDirs, [BUILTIN_PERSONA_DIR])

  const personas = loadPersonas(cfg.llm)
  assert.equal(personas.length, 58)

  // 20 main characters across 5 units
  const expectedMain = [
    ['星乃一歌', CANONICAL_UNITS.LN],
    ['天马咲希', CANONICAL_UNITS.LN],
    ['望月穗波', CANONICAL_UNITS.LN],
    ['日野森志步', CANONICAL_UNITS.LN],
    ['花里实乃理', CANONICAL_UNITS.MMJ],
    ['桐谷遥', CANONICAL_UNITS.MMJ],
    ['桃井爱莉', CANONICAL_UNITS.MMJ],
    ['日野森雫', CANONICAL_UNITS.MMJ],
    ['小豆泽心羽', CANONICAL_UNITS.VBS],
    ['白石杏', CANONICAL_UNITS.VBS],
    ['东云彰人', CANONICAL_UNITS.VBS],
    ['青柳冬弥', CANONICAL_UNITS.VBS],
    ['天马司', CANONICAL_UNITS.WXS],
    ['凤笑梦', CANONICAL_UNITS.WXS],
    ['草薙宁宁', CANONICAL_UNITS.WXS],
    ['神代类', CANONICAL_UNITS.WXS],
    ['宵崎奏', CANONICAL_UNITS.N25],
    ['朝比奈真冬', CANONICAL_UNITS.N25],
    ['东云绘名', CANONICAL_UNITS.N25],
    ['晓山瑞希', CANONICAL_UNITS.N25]
  ]
  for (const [name, expectedUnit] of expectedMain) {
    const entry = personas.find((p) => p.name === name)
    assert.ok(entry, `missing main character persona: ${name}`)
    assert.equal(entry.unit, expectedUnit, `${name} unit mismatch`)
    assert.equal(entry.isVariant, false)
  }

  // 30 unit-specific Virtual Singers (6 VS x 5 units)
  const allUnits = new Set(Object.values(CANONICAL_UNITS))
  for (const vsName of ['初音未来', '镜音铃', '镜音连', '巡音流歌', 'MEIKO', 'KAITO']) {
    const unitEntries = personas.filter((p) => p.canonicalName === vsName)
    assert.equal(unitEntries.length, 5, `${vsName} must have 5 unit personas`)
    assert.deepEqual(new Set(unitEntries.map((p) => p.unit)), allUnits)
  }

  // 2 variants + 6 NPCs
  for (const variantName of ['优男彰人', '优等生真冬']) {
    const entry = personas.find((p) => p.name === variantName)
    assert.ok(entry, `missing variant persona: ${variantName}`)
    assert.equal(entry.isVariant, true)
  }
  for (const npcName of ['古泷凪', '晓山优希', '东云慎英', '真冬的母亲', '奏的父亲', '奏的母亲']) {
    assert.ok(
      personas.some((p) => p.name === npcName),
      `missing NPC persona: ${npcName}`
    )
  }

  // Spot check unit-aware lookup for Virtual Singer
  const n25Miku = personaFor(personas, {
    id: 21,
    name: '初音未来',
    shortName: '初音',
    cloudId: '21miku_night',
    path: 'cloud/21miku_night/21miku_night.model3.json',
    outfitLabel: '无人世界(25时风)',
    unit: '虚拟歌手',
    motions: [],
    facials: [],
    defaultMotion: '',
    defaultFacial: ''
  })
  assert.equal(n25Miku?.unit, CANONICAL_UNITS.N25)
  assert.ok(dialoguePersonaPrompt(n25Miku).length > 1500)
})

test('explicit config.yaml and MSS_LLM_PERSONA_DIRS support override, extension, and opt-out', (t) => {
  const { dir } = withIsolatedEnv(t, 'llm:\n  personaDirs: []\n')

  // Explicit empty array in config.yaml opts out of built-in personas
  const optOutCfg = loadHostConfig()
  assert.deepEqual(optOutCfg.llm.personaDirs, [])
  assert.equal(loadPersonas(optOutCfg.llm).length, 0)

  // Custom directory overrides built-in when specified alone
  const customDir = path.join(dir, 'custom-personas')
  fs.mkdirSync(customDir, { recursive: true })
  fs.writeFileSync(
    path.join(customDir, '晓山瑞希.md'),
    '# 晓山瑞希\n\n## 核心机制\n\n自定义瑞希人设覆盖测试。\n',
    'utf8'
  )

  process.env.MSS_LLM_PERSONA_DIRS = customDir
  const overrideCfg = loadHostConfig()
  assert.deepEqual(overrideCfg.llm.personaDirs, [customDir])
  const overridePersonas = loadPersonas(overrideCfg.llm)
  assert.equal(overridePersonas.length, 1)
  assert.ok(overridePersonas[0].prompt.includes('自定义瑞希人设覆盖测试'))

  // Extending built-in personas: later directory overrides matching character
  process.env.MSS_LLM_PERSONA_DIRS = `personas/pjsk,${customDir}`
  const extendCfg = loadHostConfig()
  assert.deepEqual(extendCfg.llm.personaDirs, [BUILTIN_PERSONA_DIR, customDir])
  const extendedPersonas = loadPersonas(extendCfg.llm)
  assert.equal(extendedPersonas.length, 58)
  const overriddenMizuki = extendedPersonas.find((p) => p.name === '晓山瑞希')
  assert.ok(overriddenMizuki?.prompt.includes('自定义瑞希人设覆盖测试'))

  // Explicit env opt-out via "none"
  process.env.MSS_LLM_PERSONA_DIRS = 'none'
  const envOptOutCfg = loadHostConfig()
  assert.deepEqual(envOptOutCfg.llm.personaDirs, [])
})
