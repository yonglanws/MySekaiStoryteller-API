import { ILogObj, Logger } from 'tslog'
import { DEFAULT_BGM_FADE_MS, MAX_BGM_FADE_MS } from '../../common/audio/bgm'
import { StorySchema, type StoryData } from '../../common/types/Story'
import type { CatalogView } from './prompt'

const TALK_LINE_WIDTH_UNITS = 26
const TALK_MAX_LINES = 3
const VALID_SIDES = new Set(['Center', 'Left', 'Right'])
const VALID_MOVE_SPEEDS = new Set(['Slow', 'Normal', 'Fast', 'Immediate'])
const VALID_SNIPPET_TYPES = new Set([
  'ChangeLayoutMode',
  'ChangeBackgroundImage',
  'ChangeBgm',
  'LayoutAppear',
  'LayoutClear',
  'Talk',
  'HideTalk',
  'Move',
  'Motion',
  'Telop',
  'BlackOut',
  'BlackIn',
  'DoParam',
  'AmbientColor',
  'PlaySe',
  'StopSe',
  'Wipe',
  'FlashbackIn',
  'FlashbackOut',
  'CameraMove',
  'CameraZoom',
  'ShakeScreen'
])

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const toBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase())
  if (typeof value === 'number') return value !== 0
  return fallback
}

const toStr = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

const cleanPath = (value: unknown, fallback = ''): string => {
  const text = toStr(value, fallback)
    .replace(/\\/g, '/')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*\/\s*/g, '/')
    .trim()
  return text || fallback
}

/** 字符显示宽度：CJK/全角记 1，ASCII 记 0.5。 */
export function charWidthUnits(char: string): number {
  return char.codePointAt(0)! >= 0x2e80 ? 1 : 0.5
}

/**
 * 清洗台词/字幕：统一换行、折叠连续空白、按 26 字宽硬折行。
 * 只排版不删台词；超行由 splitOverflowTalks 拆条。
 */
export function sanitizeDisplayText(text: unknown, wrap = true): string {
  if (typeof text !== 'string') return ''
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (!cleaned) return ''
  if (!wrap) {
    return cleaned
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
  }
  const lines: string[] = []
  const breakAfter = /[。！？!?…、，,.\s」』）)]/
  for (const rawSegment of cleaned.split('\n')) {
    const segment = rawSegment.trim()
    if (!segment) continue
    let current: string[] = []
    let width = 0
    const flush = (): void => {
      if (current.length > 0) lines.push(current.join(''))
      current = []
      width = 0
    }
    for (const char of segment) {
      const charWidth = charWidthUnits(char)
      if (current.length > 0 && width + charWidth > TALK_LINE_WIDTH_UNITS) {
        // 优先在上一个标点/空格后折行，避免把中文词或语气词拦腰截断；
        // 找不到合适的断点时才按宽度硬折。
        let breakAt = -1
        for (let index = current.length - 1; index > 0; index--) {
          if (breakAfter.test(current[index])) {
            breakAt = index
            break
          }
        }
        if (breakAt > 0 && breakAt < current.length - 1) {
          const head = current.slice(0, breakAt + 1)
          const tail = current.slice(breakAt + 1)
          lines.push(head.join(''))
          current = tail
          width = tail.reduce((sum, item) => sum + charWidthUnits(item), 0)
        } else {
          flush()
        }
      }
      current.push(char)
      width += charWidth
    }
    flush()
  }
  return lines.join('\n')
}

function splitTtsText(tts: string, groupCount: number): string[] {
  const lineParts = tts
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
  if (lineParts.length === groupCount) return lineParts

  const sentenceParts = tts
    .split(/(?<=[。！？!?.])\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (sentenceParts.length === groupCount) return sentenceParts
  if (sentenceParts.length > groupCount) {
    const base = Math.floor(sentenceParts.length / groupCount)
    const extra = sentenceParts.length % groupCount
    const buckets: string[] = []
    let index = 0
    for (let i = 0; i < groupCount; i++) {
      const take = base + (i < extra ? 1 : 0)
      buckets.push(
        sentenceParts
          .slice(index, index + take)
          .join('')
          .trim()
      )
      index += take
    }
    return buckets
  }
  if (lineParts.length >= groupCount) {
    const base = Math.floor(lineParts.length / groupCount)
    const extra = lineParts.length % groupCount
    const buckets: string[] = []
    let index = 0
    for (let i = 0; i < groupCount; i++) {
      const take = base + (i < extra ? 1 : 0)
      buckets.push(lineParts.slice(index, index + take).join('\n'))
      index += take
    }
    return buckets
  }
  return Array.from({ length: groupCount }, () => '')
}

/** 把超过 3 行的 Talk 拆成同角色连续多条，台词一字不丢。 */
export function splitOverflowTalks(story: JsonRecord): JsonRecord {
  const snippets = story.snippets
  if (!Array.isArray(snippets)) return story

  const result: unknown[] = []
  for (const snippet of snippets) {
    if (!isRecord(snippet) || snippet.type !== 'Talk') {
      result.push(snippet)
      continue
    }
    const data = isRecord(snippet.data) ? snippet.data : {}
    const lines = toStr(data.content)
      .split('\n')
      .filter((line) => line.trim().length > 0)
    if (lines.length <= TALK_MAX_LINES) {
      result.push(snippet)
      continue
    }

    const groups: string[][] = []
    for (let index = 0; index < lines.length; index += TALK_MAX_LINES) {
      groups.push(lines.slice(index, index + TALK_MAX_LINES))
    }
    const ttsGroups = splitTtsText(toStr(data.ttsText), groups.length)
    const weights = groups.map((group) =>
      Math.max(
        1,
        [...group.join('')].reduce((sum, char) => sum + charWidthUnits(char), 0)
      )
    )
    const total = weights.reduce((sum, value) => sum + value, 0)
    let start = 0
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const end = groupIndex < groups.length - 1 ? start + weights[groupIndex] / total : 1
      const partData: JsonRecord = {
        ...data,
        content: groups[groupIndex].join('\n'),
        ttsText: ttsGroups[groupIndex]
      }
      if (Array.isArray(data.actions)) {
        partData.actions = []
        for (const action of data.actions) {
          if (!isRecord(action)) continue
          const at = toNumber(action.at)
          if ((at >= start && at < end) || (groupIndex === groups.length - 1 && at === 1)) {
            ;(partData.actions as unknown[]).push({
              ...action,
              at: Math.min(1, Math.max(0, (at - start) / (end - start)))
            })
          }
        }
      }
      if (groupIndex > 0) {
        partData.motion = ''
        partData.facial = ''
      }
      result.push({
        type: 'Talk',
        wait: Boolean(snippet.wait),
        delay: groupIndex === 0 ? toNumber(snippet.delay) : 0.15,
        data: partData
      })
      start = end
    }
  }
  story.snippets = result
  return story
}

function offscreenPosition(side: string): JsonRecord {
  return side === 'Center'
    ? { side: 'Right', offset: 100 }
    : { side, offset: side === 'Left' ? -100 : 100 }
}

const isStandingMotion = (name: string): boolean => {
  const lower = name.toLowerCase()
  return lower.includes('default') || lower.includes('stand')
}

function pickStageMotion(view: CatalogView, modelId: number): string {
  const model = view.modelById(modelId)
  for (const name of model?.motions ?? []) {
    if (!isStandingMotion(name)) return name
  }
  return view.defaultMotion(modelId)
}

function fixAnimation(
  view: CatalogView,
  modelId: number,
  field: 'motion' | 'facial',
  value: unknown
): string | null {
  const cleaned = cleanPath(value)
  if (!cleaned) return null
  const choices = view.animationChoices(modelId, field)
  if (choices.has(cleaned)) return cleaned
  return view.canonicalAnimation(modelId, field, cleaned)
}

function validateActions(
  data: JsonRecord,
  view: CatalogView,
  modelIds: Set<number>,
  label: string
): void {
  if (!('actions' in data) || data.actions === undefined) return
  const actions = data.actions
  if (!Array.isArray(actions) || actions.length > 24) {
    throw new Error(`${label}.actions 必须是最多 24 项的数组`)
  }
  const normalized: JsonRecord[] = []
  for (const [index, action] of actions.entries()) {
    if (!isRecord(action)) throw new Error(`${label}.actions[${index}] 必须是对象`)
    const at = action.at
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 1) {
      throw new Error(`${label}.actions[${index}].at 必须是 0..1 的有限数字`)
    }
    const modelId = action.modelId
    if (typeof modelId !== 'number' || !Number.isInteger(modelId) || !modelIds.has(modelId)) {
      throw new Error(`${label}.actions[${index}].modelId 必须是 models 中的角色整数 ID`)
    }
    const cleaned: JsonRecord = { at, modelId }
    for (const field of ['motion', 'facial'] as const) {
      if (!(field in action)) continue
      const fixed = fixAnimation(view, modelId, field, action[field])
      if (fixed) cleaned[field] = fixed
    }
    if (!cleaned.motion && !cleaned.facial) continue
    normalized.push(cleaned)
  }
  normalized.sort((a, b) => toNumber(a.at) - toNumber(b.at))

  const speakerId = data.modelId
  const byModel = new Map<number, JsonRecord[]>()
  for (const action of normalized) {
    const modelId = action.modelId as number
    if (!byModel.has(modelId)) byModel.set(modelId, [])
    byModel.get(modelId)!.push(action)
  }
  const kept: JsonRecord[] = []
  for (const [actorId, items] of byModel) {
    const isListener = actorId !== speakerId
    const cap = isListener ? 1 : 5
    let lastAt: number | null = null
    let count = 0
    for (const action of items) {
      if (count >= cap) continue
      const at = toNumber(action.at)
      if (lastAt !== null && at - lastAt < 0.2 - 1e-9) continue
      kept.push(action)
      lastAt = at
      count += 1
    }
  }
  kept.sort((a, b) => toNumber(a.at) - toNumber(b.at))
  data.actions = kept
}

/**
 * 严格舞台校验：不在场说话、重复入场、双人同侧、第三人入场都会抛错，
 * 由上层把错误信息交给模型重写（不在这里删角色或台词）。
 */
function normalizeScene(story: JsonRecord): void {
  const visible = new Map<number, JsonRecord>()
  for (const [index, snippet] of (story.snippets as JsonRecord[]).entries()) {
    const kind = snippet.type as string
    const data = isRecord(snippet.data) ? snippet.data : {}
    const modelId = data.modelId as number | undefined
    const label = `snippets[${index}] ${kind}`

    if (kind === 'ChangeLayoutMode') {
      data.mode = 'Normal'
      continue
    }
    if (kind === 'LayoutAppear') {
      if (typeof modelId !== 'number') throw new Error(`${label} 缺少 modelId`)
      if (visible.has(modelId)) throw new Error(`${label} 角色已在场，不能重复入场`)
      if (visible.size >= 2) {
        throw new Error(`${label} 同时最多两人在场；先 LayoutClear(wait:true) 完全滑出旧角色再入场`)
      }
      const fadeIn = toBool(data.fadeIn, false)
      const to = isRecord(data.to) ? data.to : {}
      const side = VALID_SIDES.has(toStr(to.side)) ? toStr(to.side) : 'Left'
      const position = { side, offset: toNumber(to.offset, 0) }
      for (const current of visible.values()) {
        if (current.side === side || current.side === 'Center' || side === 'Center') {
          throw new Error(`${label} 双人必须占用不同的 Left/Right 槽位`)
        }
      }
      data.to = position
      // fadeIn：原地淡入，不滑入（官方逐段上下场的常见做法）。
      data.from = fadeIn ? { ...position } : offscreenPosition(side)
      visible.set(modelId, position)
      continue
    }
    if (kind === 'LayoutClear' || kind === 'Move') {
      if (typeof modelId !== 'number' || !visible.has(modelId)) {
        throw new Error(`${label} 角色不在场`)
      }
      const current = visible.get(modelId)!
      data.from = { ...current }
      snippet.wait = true
      if (kind === 'LayoutClear') {
        data.to = toBool(data.fadeOut, false)
          ? { ...current }
          : offscreenPosition(toStr(current.side))
        visible.delete(modelId)
      } else {
        const to = isRecord(data.to) ? data.to : {}
        const side = VALID_SIDES.has(toStr(to.side)) ? toStr(to.side) : 'Left'
        for (const [other, currentPosition] of visible) {
          if (other === modelId) continue
          if (
            currentPosition.side === side ||
            currentPosition.side === 'Center' ||
            side === 'Center'
          ) {
            throw new Error(`${label} 不能移入已占用的槽位`)
          }
        }
        visible.set(modelId, { side, offset: 0 })
      }
      continue
    }
    if (kind === 'Talk' || kind === 'Motion' || kind === 'DoParam') {
      if (modelId !== -1 && (typeof modelId !== 'number' || !visible.has(modelId))) {
        throw new Error(`${label} 说话/动作角色必须已入场且未退场`)
      }
      if (kind === 'Talk' && modelId === -1 && (data.motion || data.facial)) {
        throw new Error(`${label} 旁白不能播放角色动作`)
      }
      if (Array.isArray(data.actions)) {
        for (const action of data.actions) {
          if (
            !isRecord(action) ||
            typeof action.modelId !== 'number' ||
            !visible.has(action.modelId)
          ) {
            throw new Error(`${label}.actions 的角色不在场，不能表演听者反应`)
          }
        }
      }
      if (kind === 'Motion' && 'actions' in data) snippet.wait = true
    }
  }
}

export interface ValidationResult {
  story: StoryData
  warnings: string[]
}

/**
 * 补齐最基本的开场/收尾镜头：AI 偶尔会漏掉 ChangeLayoutMode 或 ChangeBackgroundImage，
 * 结果整片白底或直接黑屏结束。这里只在完全缺失时补一条，不覆盖模型已经写好的演出。
 */
function ensureOpeningAndEnding(story: JsonRecord): void {
  const snippets = story.snippets as JsonRecord[]
  if (!snippets.some((snippet) => snippet.type === 'ChangeLayoutMode')) {
    snippets.unshift({
      type: 'ChangeLayoutMode',
      wait: false,
      delay: 0,
      data: { mode: 'Normal' }
    })
  }

  const images = Array.isArray(story.images) ? (story.images as JsonRecord[]) : []
  if (images.length > 0 && !snippets.some((snippet) => snippet.type === 'ChangeBackgroundImage')) {
    const imageId = toNumber(images[0].id, 1)
    const firstScene = snippets.findIndex((snippet) => snippet.type !== 'ChangeLayoutMode')
    snippets.splice(firstScene < 0 ? snippets.length : firstScene, 0, {
      type: 'ChangeBackgroundImage',
      wait: false,
      delay: 0,
      data: { imageId }
    })
  }

  const hasEnding = snippets.slice(-3).some((snippet) => snippet.type === 'BlackOut')
  if (!hasEnding) {
    snippets.push({ type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } })
  }
}

/**
 * 单段生成时模型在顶层写 `bgm`（与 images 对齐的数组或单个字符串），
 * 这里把它编译成 ChangeBgm 片段：第一首在开场，后续在对应背景切换前接上。
 * 只有 bgm.yaml 登记过的文件才会被采用；非法值直接忽略并回退全局默认。
 */
function compileStoryBgm(
  story: JsonRecord,
  view: CatalogView,
  warn: (message: string) => void
): void {
  const raw = story.bgm
  if (raw === undefined || raw === null) return

  const snippets = story.snippets as JsonRecord[]
  if (snippets.some((snippet) => snippet.type === 'ChangeBgm')) {
    warn('剧本同时给了顶层 bgm 和 ChangeBgm 片段，保留片段写法')
    delete story.bgm
    return
  }

  const images = Array.isArray(story.images) ? (story.images as JsonRecord[]) : []
  const list = Array.isArray(raw) ? raw : [raw]
  const entries: Array<{ imageIndex: number; file: string }> = []

  for (const [index, item] of list.entries()) {
    let file = ''
    let imageIndex = index
    let requested = ''
    if (typeof item === 'string') {
      requested = item
      file = view.canonicalBgm(item) ?? ''
    } else if (isRecord(item)) {
      requested = toStr(item.file ?? item.bgm ?? item.name ?? item.value, '')
      file = view.canonicalBgm(requested) ?? ''
      if (item.imageId !== undefined) {
        const imageId = toNumber(item.imageId, Number.NaN)
        const mapped = images.findIndex((image) => toNumber(image.id, -1) === imageId)
        if (mapped >= 0) imageIndex = mapped
      } else if (item.imageIndex !== undefined || item.index !== undefined) {
        imageIndex = Math.max(0, Math.floor(toNumber(item.imageIndex ?? item.index, index)))
      }
    }
    if (!file) {
      warn(`顶层 bgm[${index}] '${requested || '(空)'}' 不在 bgm.yaml 清单，已忽略并回退全局默认`)
      continue
    }
    entries.push({ imageIndex, file })
  }

  delete story.bgm
  if (entries.length === 0) return

  const limit = Math.max(1, images.length)
  const insertBefore = new Map<number, JsonRecord[]>()
  let lastFile = ''

  for (const entry of entries.slice(0, limit)) {
    if (entry.file === lastFile) continue
    lastFile = entry.file
    const cue: JsonRecord = {
      type: 'ChangeBgm',
      wait: false,
      delay: 0,
      data: { file: entry.file, stop: false, fadeMs: DEFAULT_BGM_FADE_MS }
    }

    if (entry.imageIndex <= 0) {
      if (!insertBefore.has(0)) insertBefore.set(0, [])
      insertBefore.get(0)!.push(cue)
      continue
    }

    const image = images[entry.imageIndex]
    const imageId = image ? toNumber(image.id, entry.imageIndex + 1) : entry.imageIndex + 1
    let target = snippets.findIndex((snippet) => {
      const data = isRecord(snippet.data) ? snippet.data : {}
      return snippet.type === 'ChangeBackgroundImage' && toNumber(data.imageId, -1) === imageId
    })
    if (target < 0) {
      target = snippets.findIndex((snippet) => snippet.type === 'ChangeBackgroundImage')
    }
    if (target < 0) target = snippets.length
    if (!insertBefore.has(target)) insertBefore.set(target, [])
    insertBefore.get(target)!.push(cue)
  }

  const result: JsonRecord[] = []
  for (let index = 0; index < snippets.length; index++) {
    const cues = insertBefore.get(index)
    if (cues) result.push(...cues)
    result.push(snippets[index])
  }
  const tail = insertBefore.get(snippets.length)
  if (tail) result.push(...tail)
  story.snippets = result
}

/**
 * 校验并尽可能修复模型生成的剧本。
 *
 * 任何会破坏舞台语义的错误（不在场说话、双人同侧等）都会抛出，
 * 由 StoryWriter 带错误信息请求模型重写；命名类错误则直接按目录纠正/丢弃。
 */
export interface ValidationOptions {
  /** TTS 支持的情绪标签；提供时把不在列表里的 Talk.emotion 清空 */
  emotionLabels?: string[]
}

export function validateAndFixStory(
  input: unknown,
  view: CatalogView,
  logger?: Logger<ILogObj>,
  options: ValidationOptions = {}
): ValidationResult {
  if (!isRecord(input)) throw new Error('剧本必须是 JSON 对象')
  const story: JsonRecord = structuredClone(input)
  const warnings: string[] = []
  const warn = (message: string): void => {
    warnings.push(message)
    logger?.warn(`[AI] ${message}`)
  }

  const defaultModel = view.defaultModel()
  if (!defaultModel) throw new Error('资源目录为空：请先配置 models.yaml 或拉取模型')

  // ---- models -----------------------------------------------------------------------------------------------
  if (!Array.isArray(story.models) || story.models.length === 0) {
    story.models = [{ id: defaultModel.id, model: defaultModel.path }]
  }
  const modelIds = new Set<number>()
  const idRemap = new Map<number, number>()
  const modelEntries: JsonRecord[] = []

  for (const [index, raw] of (story.models as unknown[]).entries()) {
    if (!isRecord(raw)) throw new Error(`models[${index}] 必须是角色对象`)
    const rawId = toNumber(raw.id, Number.NaN)
    let catalog = Number.isFinite(rawId) ? view.modelById(rawId) : null
    let modelId = catalog?.id

    if (!catalog) {
      const path = cleanPath(raw.model)
      catalog =
        (path
          ? (view.models.find((model) => model.path === path) ??
            view.models.find((model) => path.endsWith(model.path) || model.path.endsWith(path)))
          : undefined) ??
        view.models.find(
          (model) => path.length > 0 && path.split('/').pop() === model.path.split('/').pop()
        ) ??
        null
      if (!catalog) {
        throw new Error(
          `models[${index}].id/path 必须来自角色目录（收到 id=${String(raw.id)}, model=${path}）`
        )
      }
      modelId = catalog.id
      if (Number.isFinite(rawId)) idRemap.set(rawId, catalog.id)
      warn(`models[${index}] 的 id=${rawId} 与 model 路径不一致，已按目录改为 ${catalog.id}`)
    }

    if (modelId === undefined) throw new Error(`models[${index}] 无法对应角色目录`)
    if (modelIds.has(modelId)) throw new Error(`models 中角色 id 重复: ${modelId}`)
    modelIds.add(modelId)
    modelEntries.push({
      id: modelId,
      model: catalog.path,
      normal_scale: toNumber(raw.normal_scale, 2.1),
      small_scale: toNumber(raw.small_scale, 1.8),
      anchor: toNumber(raw.anchor, 0.5)
    })
  }
  story.models = modelEntries

  const remapId = (value: unknown): unknown => {
    if (typeof value !== 'number') return value
    return idRemap.get(value) ?? value
  }

  // ---- images -----------------------------------------------------------------------------------------------
  const validImages = view.validImages()
  const fixImage = (value: unknown): string => {
    const cleaned = cleanPath(value)
    if (validImages.has(cleaned)) return cleaned
    const lower = cleaned.toLowerCase()
    for (const candidate of validImages) {
      if (candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase())) {
        return candidate
      }
    }
    return view.defaultImage()
  }

  if (!Array.isArray(story.images) || story.images.length === 0) {
    story.images = [{ id: 1, image: view.defaultImage() }]
  } else {
    story.images = (story.images as unknown[]).map((raw, index) => {
      if (!isRecord(raw)) return { id: index + 1, image: view.defaultImage() }
      return {
        id: toNumber(raw.id, index + 1),
        image: fixImage(raw.image)
      }
    })
  }
  if (!view.defaultImage()) {
    story.images = []
  }

  // ---- snippets ---------------------------------------------------------------------------------------------
  if (!Array.isArray(story.snippets) || story.snippets.length === 0) {
    throw new Error('snippets 必须是非空数组')
  }

  const droppedSnippets = new Set<number>()
  for (const [index, raw] of (story.snippets as unknown[]).entries()) {
    if (!isRecord(raw) || typeof raw.type !== 'string' || !VALID_SNIPPET_TYPES.has(raw.type)) {
      throw new Error(`snippets[${index}] 必须是有效类型的片段对象`)
    }
    const snippet = raw
    const kind = snippet.type as string
    snippet.wait = toBool(snippet.wait, false)
    snippet.delay = toNumber(snippet.delay, 0)
    if (!Number.isFinite(snippet.delay) || (snippet.delay as number) < 0) {
      throw new Error(`snippets[${index}].delay 必须是非负有限秒数`)
    }

    const needsData = kind !== 'HideTalk'
    if (needsData) {
      if (!isRecord(snippet.data)) snippet.data = {}
    }
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (['Talk', 'Motion', 'LayoutAppear', 'LayoutClear', 'Move', 'DoParam'].includes(kind)) {
      if (!('modelId' in data)) data.modelId = defaultModel.id
      data.modelId = remapId(data.modelId)
      const modelId = data.modelId
      const allowNarration = kind === 'Talk' && modelId === -1
      if (
        typeof modelId !== 'number' ||
        !Number.isInteger(modelId) ||
        (!modelIds.has(modelId) && !allowNarration)
      ) {
        throw new Error(
          `snippets[${index}].modelId 必须是 models 中的角色整数 ID（旁白 Talk 可用 -1）`
        )
      }
      if (kind === 'Talk' || kind === 'Motion') {
        if (Array.isArray(data.actions)) {
          data.actions = data.actions.map((action) =>
            isRecord(action) ? { ...action, modelId: remapId(action.modelId) } : action
          )
        }
        validateActions(data, view, modelIds, `snippets[${index}]`)
      }
    }

    if (kind === 'Talk') {
      const modelId = data.modelId as number
      const model = modelId === -1 ? null : view.modelById(modelId)
      const speakerRaw = toStr(data.speaker, '')
      if (model && ![model.name, model.shortName].includes(speakerRaw)) {
        data.speaker = view.shortName(model)
        if (speakerRaw)
          warn(`snippets[${index}] speaker '${speakerRaw}' 与 modelId 不符，已改为 ${data.speaker}`)
      } else {
        data.speaker = speakerRaw || (model ? view.shortName(model) : '')
      }
      const content = toStr(data.content, '...').replace(/\\n/g, '\n')
      data.content = sanitizeDisplayText(content) || '...'
      data.voice = toStr(data.voice, '')
      data.ttsText = typeof data.ttsText === 'string' && data.ttsText.trim() ? data.ttsText : ''
      const rawEmotion = toStr(data.emotion, '').trim()
      const labels = options.emotionLabels ?? []
      data.emotion =
        labels.length > 0 ? (labels.includes(rawEmotion) ? rawEmotion : '') : rawEmotion

      if (modelId === -1) {
        // 旁白没有模型，不能携带动作/表情
        data.motion = ''
        data.facial = ''
        snippet.data = data
        continue
      }

      for (const field of ['motion', 'facial'] as const) {
        const current = cleanPath(data[field])
        if (!current) {
          data[field] = ''
          continue
        }
        const fixed = fixAnimation(view, modelId, field, current)
        if (fixed) {
          data[field] = fixed
        } else if (field === 'motion') {
          warn(`snippets[${index}] motion '${current}' 不可用，已回退默认动作`)
          data[field] = view.defaultMotion(modelId)
        } else {
          warn(`snippets[${index}] facial '${current}' 不可用，已回退默认表情`)
          data[field] = view.defaultFacial(modelId)
        }
      }
      snippet.data = data
      continue
    }

    if (kind === 'ChangeBgm') {
      const stop = toBool(data.stop, false)
      const fadeMs = Math.min(
        MAX_BGM_FADE_MS,
        Math.max(0, toNumber(data.fadeMs, DEFAULT_BGM_FADE_MS))
      )
      const requested = cleanPath(data.file)

      if (stop) {
        if (requested) {
          warn(`snippets[${index}] ChangeBgm 同时给了 file 和 stop，按停止处理`)
        }
        data.file = ''
        data.stop = true
        data.fadeMs = fadeMs
        snippet.data = data
        continue
      }

      const file = view.canonicalBgm(requested)
      if (!file) {
        warn(
          `snippets[${index}] BGM '${requested || '(空)'}' 不在 bgm.yaml 清单，已丢弃并回退全局默认`
        )
        droppedSnippets.add(index)
        continue
      }

      data.file = file
      data.stop = false
      data.fadeMs = fadeMs
      snippet.data = data
      continue
    }

    if (kind === 'LayoutAppear') {
      const modelId = data.modelId as number
      const fadeIn = toBool(data.fadeIn, false)
      for (const field of ['motion', 'facial'] as const) {
        const fixed = fixAnimation(view, modelId, field, data[field])
        if (fixed) data[field] = fixed
        else data[field] = field === 'facial' ? view.defaultFacial(modelId) : ''
      }
      if (!fadeIn && (!data.motion || isStandingMotion(toStr(data.motion)))) {
        data.motion = pickStageMotion(view, modelId)
      }
      if (fadeIn) data.motion = typeof data.motion === 'string' ? data.motion : ''
      data.facialFirst = toBool(data.facialFirst, true)
      data.moveSpeed = VALID_MOVE_SPEEDS.has(toStr(data.moveSpeed))
        ? toStr(data.moveSpeed)
        : 'Normal'
      data.hologram = toBool(data.hologram, false)
      const to = isRecord(data.to) ? data.to : {}
      const side = VALID_SIDES.has(toStr(to.side)) ? toStr(to.side) : 'Left'
      const offset = toNumber(to.offset, 0)
      data.to = { side, offset }
      // fadeIn：原地淡入（官方逐段上下场的常见做法），不滑入也不播入场动作。
      data.from = fadeIn ? { side, offset } : offscreenPosition(side)
      snippet.data = data
      continue
    }

    if (kind === 'LayoutClear') {
      const modelId = data.modelId as number
      const fadeOut = toBool(data.fadeOut, false)
      data.moveSpeed = VALID_MOVE_SPEEDS.has(toStr(data.moveSpeed))
        ? toStr(data.moveSpeed)
        : 'Normal'
      const from = isRecord(data.from) ? data.from : {}
      const side = VALID_SIDES.has(toStr(from.side)) ? toStr(from.side) : 'Center'
      const offset = toNumber(from.offset, 0)
      data.from = { side, offset }
      data.to = fadeOut ? { side, offset } : offscreenPosition(side)
      let motion = fixAnimation(view, modelId, 'motion', data.motion)
      if (fadeOut) motion = ''
      else if (!motion || isStandingMotion(motion)) motion = pickStageMotion(view, modelId)
      data.motion = motion
      let facial = fixAnimation(view, modelId, 'facial', data.facial)
      if (fadeOut) facial = ''
      else if (!facial) facial = view.defaultFacial(modelId)
      data.facial = facial
      snippet.data = data
      continue
    }

    if (kind === 'Motion') {
      const modelId = data.modelId as number
      const hasActions = 'actions' in data
      if (hasActions || 'duration' in data) {
        const duration = toNumber(data.duration, 2)
        if (!(duration > 0) || duration > 120) {
          throw new Error(`snippets[${index}].duration 必须大于 0 且不超过 120 秒`)
        }
        data.duration = duration
      }
      const motion = fixAnimation(view, modelId, 'motion', data.motion)
      const facial = fixAnimation(view, modelId, 'facial', data.facial)
      data.motion = motion ?? (hasActions ? '' : view.defaultMotion(modelId))
      data.facial = facial ?? (hasActions ? '' : view.defaultFacial(modelId))
      data.facialFirst = toBool(data.facialFirst, true)
      snippet.data = data
      continue
    }

    if (kind === 'Move') {
      data.moveSpeed = VALID_MOVE_SPEEDS.has(toStr(data.moveSpeed))
        ? toStr(data.moveSpeed)
        : 'Normal'
      const from = isRecord(data.from) ? data.from : {}
      const to = isRecord(data.to) ? data.to : {}
      data.from = {
        side: VALID_SIDES.has(toStr(from.side)) ? toStr(from.side) : 'Center',
        offset: toNumber(from.offset, 0)
      }
      data.to = {
        side: VALID_SIDES.has(toStr(to.side)) ? toStr(to.side) : 'Left',
        offset: toNumber(to.offset, 0)
      }
      snippet.data = data
      continue
    }

    if (kind === 'BlackOut' || kind === 'BlackIn') {
      data.duration = toNumber(data.duration, kind === 'BlackOut' ? 800 : 1000)
      snippet.data = data
      continue
    }

    if (kind === 'ChangeBackgroundImage') {
      data.imageId = toNumber(data.imageId, 1)
      snippet.data = data
      continue
    }

    if (kind === 'ChangeLayoutMode') {
      data.mode = 'Normal'
      snippet.data = data
      continue
    }

    if (kind === 'Telop') {
      data.content = sanitizeDisplayText(toStr(data.content), false)
      snippet.data = data
      continue
    }

    if (kind === 'DoParam') {
      if (!Array.isArray(data.params)) data.params = []
      snippet.data = data
    }
  }

  if (droppedSnippets.size > 0) {
    story.snippets = (story.snippets as JsonRecord[]).filter(
      (_snippet, index) => !droppedSnippets.has(index)
    )
  }

  ensureOpeningAndEnding(story)
  compileStoryBgm(story, view, warn)
  normalizeScene(story)
  splitOverflowTalks(story)

  const parsed = StorySchema.parse(story)
  return { story: parsed, warnings }
}
