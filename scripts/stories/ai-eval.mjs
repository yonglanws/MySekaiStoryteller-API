#!/usr/bin/env node
/**
 * AI 剧本生成评测：直接调用宿主的三段式流水线，落盘剧本并计算与官方基线的差距。
 *
 * 用法：
 *   set MSS_LLM_API_KEY=sk-...
 *   node scripts/stories/ai-eval.mjs --runs 1 --out D:/msst-lab/runs/v1
 *
 * 参数：
 *   --base-url   OpenAI 兼容根地址（默认读 MSS_LLM_BASE_URL 或官方）
 *   --model      模型名
 *   --runs       每个场景生成几次（默认 1）
 *   --prompts    all | 逗号分隔的场景编号（1 开始）
 *   --out        输出目录
 *   --target     目标时长分钟（默认 3）
 *   --pipeline   staged | single
 */
import fs from 'node:fs'
import path from 'node:path'
import { Logger } from 'tslog'
import { loadHostConfig } from '../../out-host/host/config.js'
import { ResourceCatalog } from '../../out-host/host/resources/resourceCatalog.js'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'
import { aggregate, printAggregate, storyToLines, summarize } from './story-metrics-lib.mjs'

const PROMPTS = [
  {
    id: 'classroom-live',
    cast: ['瑞希', '绘名'],
    prompt: '放学后的教室，瑞希和绘名一边收拾东西一边聊起下次 Live 要选什么曲'
  },
  {
    id: 'sekai-song',
    cast: ['奏', '真冬'],
    prompt: '深夜的无人 SEKAI，奏写不出歌，真冬安静地陪在旁边'
  },
  {
    id: 'sketchbook',
    cast: ['瑞希', '绘名'],
    prompt: '瑞希在画室发现了绘名藏起来的速写本，里面画着 Nightcord 的大家'
  },
  {
    id: 'hot-drink',
    cast: ['瑞希', '绘名'],
    prompt: '绘名在画室熬夜赶稿，瑞希带着热饮进来，劝她休息一会儿'
  },
  {
    id: 'rain',
    cast: ['瑞希', '绘名'],
    prompt: '两人在便利店门口躲雨，聊起文化祭要做什么'
  },
  {
    id: 'happy-question',
    cast: ['奏', '真冬'],
    prompt: '奏问真冬最近有没有开心的事，真冬想了很久才回答'
  },
  {
    id: 'secret',
    cast: ['瑞希', '绘名'],
    prompt: '瑞希想告诉绘名一个秘密，话到嘴边又咽了回去'
  },
  {
    id: 'song-choice',
    cast: ['瑞希', '绘名'],
    prompt: '绘名和瑞希为下一首曲子的风格争执，最后各退一步'
  }
]

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.MSS_LLM_BASE_URL || '',
    model: process.env.MSS_LLM_MODEL || 'deepseek-v4.1-flash',
    runs: 1,
    prompts: 'all',
    out: '',
    target: 3,
    pipeline: 'staged',
    temperature: Number(process.env.MSS_LLM_TEMPERATURE || 0.85)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--base-url') out.baseUrl = next()
    else if (arg === '--model') out.model = next()
    else if (arg === '--runs') out.runs = Number(next())
    else if (arg === '--prompts') out.prompts = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--target') out.target = Number(next())
    else if (arg === '--pipeline') out.pipeline = next()
    else if (arg === '--temperature') out.temperature = Number(next())
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!out.out) throw new Error('--out is required')
  return out
}

const slug = (value) => value.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = loadHostConfig()
  if (args.baseUrl) config.llm.baseUrl = args.baseUrl
  config.llm.model = args.model
  config.llm.temperature = args.temperature
  config.llm.pipeline = args.pipeline
  config.llm.translateForTts = false
  config.llm.repairRounds = 2
  config.llm.jsonMode = 'auto'
  config.llm.maxTokens = Number(process.env.MSS_LLM_MAX_TOKENS || 16384)
  config.llm.timeoutMs = Number(process.env.MSS_LLM_TIMEOUT_MS || 180000)
  config.llm.enabled = true

  const logger = new Logger({ type: 'hidden' })
  const catalog = new ResourceCatalog(logger, config)
  const llm = new LlmClient(config.llm, logger)
  if (!llm.enabled) throw new Error('LLM 未启用：检查 MSS_LLM_API_KEY / llm.enabled')

  const emotionLabels = config.tts.irodori?.emotionLabels ?? []
  const writer = new StoryWriter(llm, config.llm, catalog, logger, emotionLabels)
  const catalogData = catalog.get()
  console.log(
    `catalog: models=${catalogData.models.length} images=${catalogData.imageDetails?.length ?? 0} bgm=${catalogData.bgmDetails?.length ?? 0} emotion=${emotionLabels.join('/') || 'none'}`
  )

  const selected =
    args.prompts === 'all'
      ? PROMPTS
      : args.prompts
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value))
          .map((value) => PROMPTS[value - 1])
          .filter(Boolean)

  const outDir = path.resolve(args.out)
  fs.mkdirSync(outDir, { recursive: true })

  const results = []
  for (const prompt of selected) {
    for (let run = 1; run <= args.runs; run++) {
      const label = `${prompt.id}-r${run}`
      const started = Date.now()
      console.log(`\n[${label}] ${prompt.prompt}`)
      try {
        const result = await writer.generate({
          prompt: prompt.prompt,
          mode: 'story',
          cast: prompt.cast,
          targetMinutes: args.target,
          pipeline: args.pipeline,
          translateForTts: false
        })
        const lines = storyToLines(result.story)
        const summary = summarize(lines)
        const record = {
          label,
          prompt: prompt.prompt,
          requestedCast: prompt.cast,
          elapsedMs: Date.now() - started,
          meta: result.meta,
          summary,
          story: result.story
        }
        fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(record, null, 2))
        results.push({ label, summary, meta: result.meta, lines: lines.length })
        console.log(
          `  ok lines=${lines.length} cast=${result.meta.cast.join('/')} rounds=${result.meta.rounds} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`
        )
        console.log(
          `  text=${JSON.stringify(summary.text)} acting=${JSON.stringify(summary.acting)} emotion=${JSON.stringify(summary.emotion)} stage=${JSON.stringify(summary.stage)}`
        )
        if (result.meta.warnings.length)
          console.log(`  warnings: ${result.meta.warnings.join(' | ')}`)
      } catch (error) {
        console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`)
        if (error?.details) console.error(`  details: ${error.details.join(' | ')}`)
        results.push({ label, error: String(error), details: error?.details ?? [] })
      }
    }
  }

  const ok = results.filter((item) => item.summary)
  const report = {
    generatedAt: new Date().toISOString(),
    model: args.model,
    baseUrl: config.llm.baseUrl,
    pipeline: args.pipeline,
    runs: args.runs,
    results: results.map((item) => ({
      label: item.label,
      lines: item.lines,
      error: item.error,
      warnings: item.meta?.warnings,
      cast: item.meta?.cast,
      latencyMs: item.meta?.latencyMs,
      summary: item.summary
    })),
    aggregate: ok.length ? aggregate(ok.map((item) => item.summary)) : null
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(
    path.join(outDir, 'all-stories.json'),
    JSON.stringify(
      ok.map((item) => ({
        label: item.label,
        story: JSON.parse(fs.readFileSync(path.join(outDir, `${item.label}.json`), 'utf8')).story
      })),
      null,
      2
    )
  )

  if (report.aggregate) printAggregate(`AI (${args.model}, ${args.pipeline})`, report.aggregate)
  console.log(`\nreport=${path.join(outDir, 'report.json')}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
