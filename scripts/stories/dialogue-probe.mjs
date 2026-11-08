#!/usr/bin/env node
/**
 * 台词轮探针：只跑第二段（选角结果固定），用于快速迭代台词提示词。
 *
 * 用法：
 *   MSS_LLM_API_KEY=... MSS_LLM_BASE_URL=... \
 *   node scripts/stories/dialogue-probe.mjs --scene "放学后瑞希和绘名聊下次 Live" \
 *     [--cast 瑞希,绘名] [--thinking off] [--out D:/.../dialogue.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { Logger } from 'tslog'
import { loadHostConfig } from '../../out-host/host/config.js'
import { ResourceCatalog } from '../../out-host/host/resources/resourceCatalog.js'
import { LlmClient, extractJson } from '../../out-host/host/ai/llm.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import { buildDialoguePrompt } from '../../out-host/host/ai/staged.js'
import { loadPersonas } from '../../out-host/host/ai/personas.js'

function parseArgs(argv) {
  const out = {
    scene: '',
    cast: '瑞希,绘名',
    thinking: 'on',
    out: '',
    baseUrl: process.env.MSS_LLM_BASE_URL || '',
    model: process.env.MSS_LLM_MODEL || 'deepseek-v4.1-flash',
    target: 3
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--scene') out.scene = next()
    else if (arg === '--cast') out.cast = next()
    else if (arg === '--thinking') out.thinking = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--base-url') out.baseUrl = next()
    else if (arg === '--model') out.model = next()
    else if (arg === '--target') out.target = Number(next())
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!out.scene) throw new Error('--scene is required')
  return out
}

const lineChars = (text) => Array.from(String(text).replace(/\s/g, '')).length

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = loadHostConfig()
  if (args.baseUrl) config.llm.baseUrl = args.baseUrl
  config.llm.model = args.model
  config.llm.translateForTts = false
  config.llm.extraBody = args.thinking === 'off' ? { thinking: { type: 'disabled' } } : {}
  const logger = new Logger({ type: 'hidden' })
  const catalog = new ResourceCatalog(logger, config)
  const view = new CatalogView(catalog.get())
  const personas = loadPersonas(config.llm)

  const tokens = args.cast
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const cast = tokens
    .map((token) => {
      const lower = token.toLowerCase()
      return view.models.find(
        (model) =>
          model.name.toLowerCase() === lower ||
          model.shortName.toLowerCase() === lower ||
          String(model.id) === token
      )
    })
    .filter(Boolean)
  if (cast.length < 2) throw new Error('需要两个可识别的角色')

  const plan = {
    title: '',
    event: args.scene,
    logline: '',
    outline: [],
    cast: cast.map((model, index) => ({
      modelId: model.id,
      name: view.shortName(model),
      fullName: model.name,
      path: model.path,
      role: index === 0 ? '发起' : '回应'
    })),
    background: ''
  }
  const built = buildDialoguePrompt(view, plan, {
    scene: args.scene,
    personas,
    targetMinutes: args.target,
    emotionLabels: config.tts.irodori?.emotionLabels ?? []
  })
  const llm = new LlmClient(config.llm, logger)
  const result = await llm.chat(
    [
      { role: 'system', content: built.system },
      { role: 'user', content: built.user }
    ],
    { json: true }
  )
  const raw = result.content
  const parsed = extractJson(raw)
  const turns = Array.isArray(parsed.turns) ? parsed.turns : []
  const lines = []
  for (const turn of turns) {
    const speaker = String(turn.speaker || '')
    const items = Array.isArray(turn.lines) ? turn.lines : [turn]
    for (const item of items) {
      const content = typeof item === 'string' ? item : String(item?.content ?? item?.text ?? '')
      if (content.trim()) lines.push({ speaker, content: content.trim() })
    }
  }
  const chars = lines.map((line) => lineChars(line.content))
  const runs = []
  for (const line of lines) {
    const last = runs[runs.length - 1]
    if (last && last.speaker === line.speaker) last.count += 1
    else runs.push({ speaker: line.speaker, count: 1 })
  }
  const summary = {
    turns: turns.length,
    lines: lines.length,
    charsMean: Number((chars.reduce((a, b) => a + b, 0) / Math.max(1, chars.length)).toFixed(2)),
    longShare: Number(
      (chars.filter((value) => value > 26).length / Math.max(1, chars.length)).toFixed(3)
    ),
    shortShare: Number(
      (chars.filter((value) => value > 0 && value <= 6).length / Math.max(1, chars.length)).toFixed(
        3
      )
    ),
    ellipsisShare: Number(
      (
        lines.filter((line) => /…|——/.test(line.content)).length / Math.max(1, lines.length)
      ).toFixed(3)
    ),
    questionShare: Number(
      (
        lines.filter((line) => /[?？]/.test(line.content)).length / Math.max(1, lines.length)
      ).toFixed(3)
    ),
    runMean: Number((lines.length / Math.max(1, runs.length)).toFixed(2)),
    soloRunShare: Number(
      (runs.filter((run) => run.count === 1).length / Math.max(1, runs.length)).toFixed(3)
    ),
    longRunShare: Number(
      (runs.filter((run) => run.count >= 4).length / Math.max(1, runs.length)).toFixed(3)
    )
  }
  console.log(JSON.stringify(summary, null, 2))
  console.log('--- lines ---')
  for (const line of lines) console.log(`${line.speaker}：${line.content.replace(/\n/g, ' / ')}`)
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
    fs.writeFileSync(
      path.resolve(args.out),
      JSON.stringify(
        { summary, raw, parsed, usage: result.usage, latencyMs: result.latencyMs },
        null,
        2
      )
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
