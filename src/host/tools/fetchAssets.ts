/**
 * 从 moesekai（pjsk.moe）拉取 Live2D 模型到 resources/models。
 *
 *   npm run fetch:models -- --characters mizuki,ena
 *   npm run fetch:models -- --models 20mizuki_normal_3.0_t04
 *   npm run fetch:models -- --characters all --region jp
 *
 * 需要先 `npm run build:host`（package script 已串起来）。
 * 下载结果直接写 models.yaml；动作包只用于转换，不会留在资源目录里。
 */
import { loadHostConfig } from '../config'
import { CHARACTERS, fetchModels, loadMoesekaiIndex, selectModels } from '../assets/moesekai'

interface Args {
  characters: string[]
  models: string[]
  region?: 'jp' | 'cn' | 'tw' | 'kr' | 'en'
  out?: string
  cache?: string
  concurrency?: number
  force: boolean
  dryRun: boolean
  list: boolean
  json: boolean
  help: boolean
}

const USAGE = `用法：npm run fetch:models -- [选项]

  --characters <keys>   角色，逗号分隔：中文名/简称/罗马字/数字 id（如 mizuki,ena,瑞希,20）
                        all = 26 位角色各拉一套首选服装
  --models <ids>        精确模型 id（可写 v2_ / clb / sub 模型），逗号分隔
  --region <code>       jp | cn | tw | kr | en（默认 jp）
  --out <dir>           资源根目录（默认 config.yaml 的 paths.resources）
  --cache <dir>         动作包缓存目录（默认 config.yaml 的 assets.cacheDir）
  --concurrency <n>     并行下载数（默认 4）
  --force               已存在的模型也重新下载
  --dry-run             只打印将要下载的模型
  --list                列出索引中匹配的模型，不下载
  --json                --list / 结果以 JSON 输出
  --help                显示本帮助

示例：
  npm run fetch:models -- --characters mizuki,ena
  npm run fetch:models -- --characters all
  npm run fetch:models -- --models 20mizuki_normal_3.0_t04,v2_01ichika_casual
  npm run fetch:models -- --list --characters mizuki`

function parseArgs(argv: string[]): Args {
  const args: Args = {
    characters: [],
    models: [],
    force: false,
    dryRun: false,
    list: false,
    json: false,
    help: false
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = (): string => {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      return value
    }
    if (arg === '--characters' || arg === '-c') {
      args.characters.push(
        ...next()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      )
    } else if (arg === '--models' || arg === '-m') {
      args.models.push(
        ...next()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      )
    } else if (arg === '--region') {
      const value = next().toLowerCase()
      if (value !== 'jp' && value !== 'cn' && value !== 'tw' && value !== 'kr' && value !== 'en') {
        throw new Error('--region 必须是 jp / cn / tw / kr / en')
      }
      args.region = value
    } else if (arg === '--out') {
      args.out = next()
    } else if (arg === '--cache') {
      args.cache = next()
    } else if (arg === '--concurrency') {
      const value = Number(next())
      if (!Number.isInteger(value) || value < 1 || value > 32) {
        throw new Error('--concurrency 必须是 1..32 的整数')
      }
      args.concurrency = value
    } else if (arg === '--force') {
      args.force = true
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--list') {
      args.list = true
    } else if (arg === '--json') {
      args.json = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--all') {
      args.characters.push('all')
    } else {
      throw new Error(`未知选项：${arg}`)
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.characters.length === 0 && args.models.length === 0) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  const config = loadHostConfig()
  const region = args.region ?? config.assets.region
  const outDir = args.out ? args.out : config.paths.resources

  if (args.list) {
    const { index, indexUrl } = await loadMoesekaiIndex(config.assets, region, {
      timeoutMs: config.assets.timeoutMs,
      retries: config.assets.retries
    })
    const selected = selectModels(index, {
      characters: args.characters,
      models: args.models
    })
    if (args.json) {
      console.log(
        JSON.stringify(
          selected.map((model) => ({
            id: model.id,
            kind: model.kind,
            characterId: model.characterId ?? null,
            bundle: model.bundle,
            motions: model.motions ?? (model.motion ? [model.motion] : []),
            bytes: model.bytes ?? 0
          })),
          null,
          2
        )
      )
    } else {
      console.log(`索引：${indexUrl}（${index.models.length} 个模型，区服 ${region}）`)
      for (const model of selected) {
        const character = CHARACTERS.find((item) => item.characterId === model.characterId)
        console.log(
          `  ${model.id}${character ? `  ${character.name}` : ''}  ${model.kind ?? ''}  ${
            model.motions?.length ?? (model.motion ? 1 : 0)
          } 个动作包`
        )
      }
      console.log(`共 ${selected.length} 个模型`)
    }
    return
  }

  if (args.dryRun) {
    const { index } = await loadMoesekaiIndex(config.assets, region, {
      timeoutMs: config.assets.timeoutMs,
      retries: config.assets.retries
    })
    const selected = selectModels(index, {
      characters: args.characters,
      models: args.models
    })
    console.log(`将下载 ${selected.length} 个模型到 ${outDir}：`)
    for (const model of selected) console.log(`  ${model.id}`)
    return
  }

  const result = await fetchModels(config.assets, {
    outDir,
    region,
    cacheDir: args.cache,
    concurrency: args.concurrency,
    characters: args.characters,
    models: args.models,
    force: args.force,
    onProgress: (message) => console.log(message)
  })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('')
    console.log(`索引：${result.indexUrl}`)
    console.log(`完成 ${result.models.length} 个模型，跳过 ${result.skipped.length} 个`)
    for (const model of result.models) {
      console.log(`  ${model.id} → ${model.path}（${model.motions} 动作 / ${model.facials} 表情）`)
    }
    if (result.added.length > 0) {
      console.log('')
      console.log(`models.yaml 新增 ${result.added.length} 条：`)
      for (const entry of result.added)
        console.log(`  id=${entry.id} ${entry.name} → ${entry.path}`)
    }
    if (result.errors.length > 0) {
      console.log('')
      console.log('失败：')
      for (const item of result.errors) console.log(`  ${item.id}: ${item.error}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
