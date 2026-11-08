/**
 * 从 Moesekai 资源站拉取背景与剧情 BGM。
 *
 *   npm run fetch:media -- --kind backgrounds --limit 20
 *   npm run fetch:media -- --kind bgm --names bgm00003,bgm00006
 *   npm run fetch:media -- --kind all --dry-run
 *
 * 下载后自动登记到 resources/images/images.yaml 与 resources/audio/bgm/bgm.yaml。
 * BGM 会先用 Sekai-World 的 musicSoundTracks 映射补上官方曲名与分类
 * （bgm00003 → Slapstick!! / 剧情 BGM），AI 才能按氛围选曲；
 * 没有官方曲名的冷门曲目仍建议在 bgm.yaml 手工补一句 description。
 */
import path from 'node:path'
import { loadHostConfig } from '../config'
import { fetchMedia, listMedia, type MediaKind } from '../assets/media'
import { loadSoundtrackIndex } from '../assets/soundtracks'

interface Args {
  kind: 'backgrounds' | 'bgm' | 'all'
  region?: 'jp' | 'cn' | 'tw' | 'kr' | 'en'
  out?: string
  assetBase?: string
  metadataBase?: string
  limit?: number
  names: string[]
  includeArea: boolean
  concurrency?: number
  force: boolean
  dryRun: boolean
  list: boolean
  metadataOnly: boolean
  noMetadata: boolean
  refreshMetadata: boolean
  json: boolean
  help: boolean
}

const USAGE = `用法：npm run fetch:media -- [选项]

  --kind <kind>         backgrounds | bgm | all（默认 all）
  --region <code>       jp | cn | tw | kr | en（默认 config.yaml 的 assets.region）
  --out <dir>           资源根目录（默认 config.yaml 的 paths.resources）
  --asset-base <url>    资源站根地址（默认 https://storage.exmeaning.com）
  --metadata-base <url> 曲名索引目录（默认 config.yaml 的 assets.soundtrackBase）
  --metadata-only       只更新曲名索引缓存，不下载 BGM
  --no-metadata         不读取官方曲名索引，清单条目保持空描述
  --refresh-metadata    忽略缓存有效期，强制更新曲名索引
  --limit <n>           每类最多处理多少个 bundle（默认 0 = 全部）
  --names <list>        只处理名称精确匹配或包含这些片段的 bundle，逗号分隔
  --include-area        同时拉取 sound/area_bgm 区域 BGM
  --concurrency <n>     下载并发数（默认 4）
  --force               已存在的文件也重新下载（仍不会重复登记清单）
  --dry-run             只列 bundle 和目标文件，不写盘
  --list                只列出资源站上匹配的 bundle，不下载
  --json                --list / 结果以 JSON 输出
  --help                显示本帮助

示例：
  npm run fetch:media -- --kind backgrounds --limit 20
  npm run fetch:media -- --kind bgm --names bgm00003,bgm00006
  npm run fetch:media -- --kind bgm --metadata-only
  npm run fetch:media -- --kind all --list --json`

function parseArgs(argv: string[]): Args {
  const args: Args = {
    kind: 'all',
    names: [],
    includeArea: false,
    force: false,
    dryRun: false,
    list: false,
    metadataOnly: false,
    noMetadata: false,
    refreshMetadata: false,
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
    if (arg === '--kind' || arg === '-k') {
      const value = next().toLowerCase()
      if (
        value === 'background' ||
        value === 'backgrounds' ||
        value === 'image' ||
        value === 'images'
      ) {
        args.kind = 'backgrounds'
      } else if (value === 'bgm' || value === 'music') {
        args.kind = 'bgm'
      } else if (value === 'all') {
        args.kind = 'all'
      } else {
        throw new Error('--kind 必须是 backgrounds / bgm / all')
      }
    } else if (arg === '--region') {
      const value = next().toLowerCase()
      if (value !== 'jp' && value !== 'cn' && value !== 'tw' && value !== 'kr' && value !== 'en') {
        throw new Error('--region 必须是 jp / cn / tw / kr / en')
      }
      args.region = value
    } else if (arg === '--out') {
      args.out = next()
    } else if (arg === '--asset-base') {
      args.assetBase = next()
    } else if (arg === '--metadata-base') {
      args.metadataBase = next()
    } else if (arg === '--metadata-only') {
      args.metadataOnly = true
    } else if (arg === '--no-metadata') {
      args.noMetadata = true
    } else if (arg === '--refresh-metadata') {
      args.refreshMetadata = true
    } else if (arg === '--limit') {
      const value = Number(next())
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--limit 必须是 >= 0 的整数')
      }
      args.limit = value
    } else if (arg === '--names' || arg === '-n') {
      args.names.push(
        ...next()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      )
    } else if (arg === '--include-area') {
      args.includeArea = true
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
    } else {
      throw new Error(`未知选项：${arg}`)
    }
  }
  return args
}

function kindsOf(kind: Args['kind']): MediaKind[] {
  if (kind === 'backgrounds') return ['background']
  if (kind === 'bgm') return ['bgm']
  return ['background', 'bgm']
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const config = loadHostConfig()
  const region = args.region ?? config.assets.region
  const outDir = args.out ? args.out : config.paths.resources
  const assetBase = args.assetBase || config.assets.assetBase || undefined
  const kinds = kindsOf(args.kind)
  const soundtrackCache = path.join(outDir, 'audio', 'bgm', 'soundtracks.json')
  const loadMeta = async (): Promise<Awaited<ReturnType<typeof loadSoundtrackIndex>>> => {
    if (!kinds.includes('bgm') || args.noMetadata || args.dryRun) return null
    return loadSoundtrackIndex({
      cacheFile: soundtrackCache,
      baseUrl: args.metadataBase || config.assets.soundtrackBase,
      timeoutMs: config.assets.timeoutMs,
      retries: Math.min(config.assets.retries, 1),
      refresh: args.refreshMetadata,
      onProgress: (message) => console.log(message)
    })
  }

  if (args.metadataOnly) {
    if (!kinds.includes('bgm')) {
      throw new Error('--metadata-only 需要 --kind bgm 或 all')
    }
    const index = await loadMeta()
    console.log(
      index
        ? `曲名索引：${index.tracks.size} 首 → ${soundtrackCache}`
        : `曲名索引不可用，未写入 ${soundtrackCache}`
    )
    return
  }

  if (args.list) {
    const result = await listMedia({
      region,
      kinds,
      assetBase,
      limit: args.limit,
      names: args.names,
      includeAreaBgm: args.includeArea,
      timeoutMs: config.assets.timeoutMs,
      retries: config.assets.retries
    })
    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`资源站：${result.assetBase}（区服 ${region}）`)
      for (const bundle of result.bundles) {
        console.log(
          `  ${bundle.kind === 'background' ? '背景' : 'BGM '} ${bundle.name}  ` +
            `${bundle.files} 文件 / ${(bundle.bytes / 1024 / 1024).toFixed(1)} MB`
        )
      }
      console.log(`共 ${result.bundles.length} 个 bundle`)
    }
    return
  }

  const soundtrackIndex = await loadMeta()
  const result = await fetchMedia({
    outDir,
    region,
    kinds,
    assetBase,
    limit: args.limit,
    names: args.names,
    includeAreaBgm: args.includeArea,
    force: args.force,
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    timeoutMs: config.assets.timeoutMs,
    retries: config.assets.retries,
    soundtrackIndex,
    onProgress: (message) => console.log(message)
  })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('')
  console.log(`资源站：${result.assetBase}`)
  console.log(
    `背景 ${result.backgrounds.length} 个，BGM ${result.bgm.length} 个` +
      (result.dryRun ? '（dry-run，未写盘）' : '')
  )
  for (const item of [...result.backgrounds, ...result.bgm]) {
    console.log(
      `  ${item.kind === 'background' ? '背景' : 'BGM '} ${item.name} → ${item.file}` +
        (item.skipped ? '（已存在，跳过）' : '')
    )
  }
  if (result.skipped.length > 0) console.log(`跳过 ${result.skipped.length} 个已存在文件`)
  if (result.addedImages.length > 0) {
    console.log(`images.yaml 新增 ${result.addedImages.length} 条（description 待补）`)
  }
  if (result.addedBgm.length > 0) {
    const named = result.addedBgm.filter((entry) => entry.description).length
    console.log(
      `bgm.yaml 新增 ${result.addedBgm.length} 条` +
        (named > 0 ? `（${named} 条已带官方曲名/分类）` : '（description 待补）')
    )
  } else if (soundtrackIndex && result.bgm.length > 0) {
    console.log('曲名索引已更新；已有 bgm.yaml 条目的空曲名/描述会由资源目录自动补全')
  }
  if (result.errors.length > 0) {
    console.log('')
    console.log('失败：')
    for (const item of result.errors) {
      console.log(`  ${item.kind} ${item.name}: ${item.error}`)
    }
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
