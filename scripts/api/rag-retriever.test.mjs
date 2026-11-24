import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { Logger } from 'tslog'
import {
  EmbeddingClient,
  PJSK_DEFAULT_QUERY_INSTRUCT,
  resolveEmbeddingConfig
} from '../../out-host/host/rag/embeddingClient.js'
import {
  calibrateRerankScores,
  parseRerankResponse,
  RerankClient,
  resolveRerankConfig
} from '../../out-host/host/rag/rerankClient.js'
import { AdaptiveRagRetriever } from '../../out-host/host/rag/retriever.js'
import {
  chunkPersonasToLore,
  chunkPjskScenario,
  isForeignOurnotesPayload,
  loadStoryCorpus,
  parseSekaiJsonlBuffer
} from '../../out-host/host/rag/storyCorpus.js'
import {
  computeChunkHash,
  dotSq8Row,
  encodePjskSq8Buffer,
  IncrementalSq8Cache,
  l2Normalize,
  parsePjskSq8Buffer,
  quantizeSq8Sym
} from '../../out-host/host/rag/vectorIndex.js'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'

/** 确定性伪语义 8 维向量：按关键词话题映射到不同正交轴，便于稳定测试混合检索与截断 */
function mockVectorFor(text) {
  const s = String(text ?? '')
  const v = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]
  if (/瑞希|绘名|天台|秘密|nightcord|25时/i.test(s)) v[0] += 1.0
  if (/绘绘|心结|道歉|坦白/i.test(s)) v[1] += 0.9
  if (/教室|放学|黄昏|屋顶/i.test(s)) v[2] += 0.7
  if (/笑梦|宁宁|wonderhoy|游乐园/i.test(s)) v[3] += 1.0
  if (/一歌|咲希|吉他|乐队/i.test(s)) v[4] += 1.0
  if (/无关|宇宙飞船|恐龙/i.test(s)) v[7] += 1.0
  return v
}

async function startMockEmbeddingServer() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        data: inputs.map((text, index) => ({
          index,
          embedding: mockVectorFor(text)
        }))
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.close()
      await once(server, 'close')
    }
  }
}

test('resolveEmbeddingConfig inherits llm.baseUrl & llm.apiKeyEnv, defaults to qwen3-embedding-8b with auto PJSK instruct', () => {
  const resolved = resolveEmbeddingConfig({
    baseUrl: 'https://llm.example/v1/',
    apiKeyEnv: 'CUSTOM_LLM_KEY',
    rag: {}
  })
  assert.equal(resolved.baseUrl, 'https://llm.example/v1')
  assert.equal(resolved.apiKeyEnv, 'CUSTOM_LLM_KEY')
  assert.equal(resolved.model, 'qwen3-embedding-8b')
  assert.equal(resolved.queryInstruct, PJSK_DEFAULT_QUERY_INSTRUCT)
  assert.equal(resolved.dimensions, 0)

  const qwenClient = new EmbeddingClient(resolved)
  assert.equal(
    qwenClient.formatQuery('瑞希 天台'),
    `Instruct: ${PJSK_DEFAULT_QUERY_INSTRUCT}\nQuery: 瑞希 天台`
  )
  // Avoid double-prefixing if already formatted
  assert.equal(
    qwenClient.formatQuery(`Instruct: custom\nQuery: 瑞希`),
    `Instruct: custom\nQuery: 瑞希`
  )

  const bgeResolved = resolveEmbeddingConfig({
    baseUrl: 'https://llm.example/v1',
    apiKeyEnv: 'CUSTOM_LLM_KEY',
    rag: { model: 'bge-m3' }
  })
  assert.equal(bgeResolved.queryInstruct, '')
  assert.equal(new EmbeddingClient(bgeResolved).formatQuery('瑞希 天台'), '瑞希 天台')
})

test('RerankClient supports logit sigmoid calibration, multi-provider parsing, 422 instruction fallback, and graceful error fallback', async (t) => {
  const rrCfg = resolveRerankConfig({
    baseUrl: 'https://llm.example/v1/',
    apiKeyEnv: 'CUSTOM_KEY',
    rag: { rerank: {} }
  })
  assert.equal(rrCfg.model, 'qwen3-reranker-8b')
  assert.equal(rrCfg.baseUrl, 'https://llm.example/v1')
  assert.equal(rrCfg.apiKeyEnv, 'CUSTOM_KEY')

  // Probability scores stay linear; raw logits calibrate via sigmoid
  const probCal = calibrateRerankScores([
    { index: 0, rawScore: 0.9 },
    { index: 1, rawScore: 0.2 }
  ])
  assert.equal(probCal[0].score, 0.9)
  const logitCal = calibrateRerankScores([
    { index: 0, rawScore: 4.0 },
    { index: 1, rawScore: -2.0 }
  ])
  assert.ok(logitCal[0].score > 0.95 && logitCal[0].score < 1)
  assert.ok(logitCal[1].score > 0 && logitCal[1].score < 0.2)

  // Multi-provider parsing
  assert.equal(
    parseRerankResponse({ output: { results: [{ index: 0, relevance_score: 0.88 }] } }).length,
    1
  )

  // Mock rerank server rejecting top-level `instruction` with 422 once, then accepting inline Instruct query with raw logits
  const seenPayloads = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    seenPayloads.push(body)
    if ('instruction' in body) {
      res.statusCode = 422
      res.end(JSON.stringify({ error: 'unknown field instruction' }))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        results: [
          { index: 1, logit: 3.5 },
          { index: 0, logit: -1.5 }
        ]
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  const client = new RerankClient({
    ...rrCfg,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`
  })
  const res = await client.rerank('瑞希 绘名 天台', ['doc0', 'doc1'])
  assert.ok(res)
  assert.equal(seenPayloads.length, 2, 'should retry once without top-level instruction on 422')
  assert.ok(seenPayloads[1].query.startsWith('Instruct:'))
  assert.equal(res.items[0].index, 1)
  assert.ok(res.items[0].score > 0.95)
})

test('PJSK domain isolation rejects Ournotes schemas/caches and resolves events_cn.json titles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-domain-iso-'))
  try {
    // Write PJSK title map + PJSK event + foreign Ournotes episode.json + foreign domain jsonl
    fs.writeFileSync(
      path.join(tmpDir, 'events_cn.json'),
      JSON.stringify([{ id: 145, name: '荆棘之路', assetbundleName: 'event_mizu5_2024' }]),
      'utf8'
    )
    const eventsDir = path.join(tmpDir, 'cn_events')
    fs.mkdirSync(eventsDir, { recursive: true })
    fs.writeFileSync(
      path.join(eventsDir, 'event_mizu5_2024__event_145_08.json'),
      JSON.stringify({
        Snippets: [{ Action: 1, ReferenceIndex: 0 }],
        TalkData: [{ WindowDisplayName: '瑞希', Body: '对不起……绘绘。' }]
      }),
      'utf8'
    )
    // Foreign Ournotes episode.json must be rejected
    fs.writeFileSync(
      path.join(eventsDir, 'foreign_episode.json'),
      JSON.stringify({
        commands: [{ AdvTextID: 't1', TargetName: 'tomori', lines: { simplifiedChinese: '灯' } }]
      }),
      'utf8'
    )
    // Foreign domain jsonl must be rejected
    fs.writeFileSync(
      path.join(tmpDir, 'foreign.jsonl'),
      JSON.stringify({ domain: 'ournotes', text: '灯: 欢迎来到 RiNG' }) + '\n',
      'utf8'
    )

    assert.equal(
      isForeignOurnotesPayload({ commands: [{ AdvTextID: '1', TargetName: 'anon' }] }),
      true
    )
    const chunks = loadStoryCorpus({ localDirs: [tmpDir], includePersonas: false })
    assert.equal(chunks.length, 1, 'only PJSK event should load; Ournotes files must be rejected')
    assert.equal(chunks[0].domain, 'pjsk')
    assert.equal(chunks[0].story, '荆棘之路', 'events_cn.json title map should resolve human-readable title')

    // Cache dir isolates by domain and rejects mismatched domain metadata
    const cacheDir = path.join(tmpDir, 'cache')
    const foreignDir = path.join(cacheDir, 'pjsk-qwen3-embedding-8b-4d')
    fs.mkdirSync(foreignDir, { recursive: true })
    fs.writeFileSync(
      path.join(foreignDir, 'embed-cache.index.json'),
      JSON.stringify({
        schemaVersion: 1,
        domain: 'ournotes',
        model: 'qwen3-embedding-8b',
        dims: 4,
        quant: 'sq8_sym',
        entries: {}
      }),
      'utf8'
    )
    const v = l2Normalize(Float32Array.from([1, 0, 0, 0]))
    const q = quantizeSq8Sym(v)
    fs.writeFileSync(
      path.join(foreignDir, 'embed-cache.sq8.bin'),
      encodePjskSq8Buffer({ count: 1, dims: 4, scales: Float32Array.from([q.scale]), data: q.data })
    )
    const pjskCache = new IncrementalSq8Cache(cacheDir, 'qwen3-embedding-8b', 4, 'pjsk')
    assert.equal(pjskCache.load(), false, 'must reject cache tagged with non-pjsk domain')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('AdaptiveRagRetriever runs two-stage RRF + reranker and expands +/-1 adjacent scenario context', async (t) => {
  const rerankServer = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        results: body.documents.map((doc, index) => ({
          index,
          relevance_score: doc.includes('关键转折') ? 0.95 : 0.3
        }))
      })
    )
  })
  rerankServer.listen(0, '127.0.0.1')
  await once(rerankServer, 'listening')
  t.after(() => rerankServer.close())

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-rag-exp-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const mk = (id, lineStart, lineEnd, text) => ({
    id,
    domain: 'pjsk',
    chunkHash: computeChunkHash(text),
    sourceKind: 'canon_story',
    storyId: 'ev_145',
    story: '荆棘之路',
    scenarioId: 'ev_145_08',
    type: 'event',
    chars: ['瑞希', '绘名'],
    lineStart,
    lineEnd,
    text
  })
  const chunks = [
    mk('p0', 0, 7, '[荆棘之路 | 瑞希, 绘名]\n瑞希: 绘绘，其实今天我有话想说。'),
    mk('p1', 6, 13, '[荆棘之路 | 瑞希, 绘名]\n瑞希: 这是天台上的关键转折，我一直不敢坦白。'),
    mk('p2', 12, 19, '[荆棘之路 | 瑞希, 绘名]\n绘名: 瑞希，别逃跑，看着我。')
  ]

  const rerankClient = new RerankClient({
    enabled: true,
    model: 'qwen3-reranker-8b',
    baseUrl: `http://127.0.0.1:${rerankServer.address().port}/v1`,
    apiKeyEnv: 'MSS_TEST_RERANK_KEY',
    endpointPath: '/rerank',
    candidatePool: 32,
    topN: 32,
    timeoutMs: 5000,
    instruction: ''
  })

  const retriever = new AdaptiveRagRetriever({
    chunks,
    settings: {
      enabled: true,
      model: 'qwen3-embedding-8b',
      cacheDir: tmpDir,
      fallbackLexical: true,
      adaptive: {
        minScore: 0.42,
        highScore: 0.62,
        relativeDropRatio: 0.78,
        elbowDropDelta: 0.065,
        minChunks: 0,
        maxChunks: 8,
        softCharBudget: 1800,
        maxCharBudget: 4800,
        maxPerStory: 2,
        mergeAdjacentGap: 4,
        expandAdjacentContext: true
      }
    },
    embeddingClient: null,
    rerankClient
  })

  const res = await retriever.retrieve({
    prompt: '瑞希和绘名在天台的关键转折',
    stage: 'dialogue',
    cast: [{ name: '瑞希' }, { name: '绘名' }]
  })

  assert.equal(res.domain, 'pjsk')
  assert.equal(res.rerankMode, 'reranked')
  assert.equal(res.rerankModel, 'qwen3-reranker-8b')
  assert.ok(res.expandedCount >= 1, 'should pull +/-1 adjacent neighbor chunks for high-score hit')
  assert.equal(res.sections.canonPlot.length, 1, 'neighbors merged into single continuous scene')
  assert.ok(res.sections.canonPlot[0].text.includes('别逃跑，看着我'))
  assert.ok(res.sections.canonPlot[0].text.includes('今天我有话想说'))
})

test('PJSK v1 sq8_sym binary round-trip and IncrementalSq8Cache persist and reuse chunkHash vectors', () => {
  const v1 = l2Normalize(Float32Array.from([1, 0, 0, 0]))
  const v2 = l2Normalize(Float32Array.from([0, 1, 0, 0]))
  const q1 = quantizeSq8Sym(v1)
  const q2 = quantizeSq8Sym(v2)
  const data = new Int8Array(8)
  data.set(q1.data, 0)
  data.set(q2.data, 4)

  const buf = encodePjskSq8Buffer({
    count: 2,
    dims: 4,
    scales: Float32Array.from([q1.scale, q2.scale]),
    data
  })
  const parsed = parsePjskSq8Buffer(buf)
  assert.equal(parsed.header.magic, 'PJSK')
  assert.equal(parsed.header.version, 1)
  assert.equal(parsed.header.quantType, 2)
  assert.equal(parsed.matrix.count, 2)
  assert.equal(parsed.matrix.dims, 4)
  assert.ok(dotSq8Row(v1, parsed.matrix, 0) > 0.99)
  assert.ok(Math.abs(dotSq8Row(v1, parsed.matrix, 1)) < 0.02)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-rag-sq8-'))
  try {
    const cacheA = new IncrementalSq8Cache(tmpDir, 'bge-m3')
    const h1 = computeChunkHash('chunk-one')
    cacheA.put(h1, v1)
    cacheA.save()

    const cacheB = new IncrementalSq8Cache(tmpDir, 'bge-m3')
    assert.equal(cacheB.load(), true)
    assert.equal(cacheB.has(h1), true)
    assert.ok(cacheB.dot(v1, h1) > 0.99)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('parseSekaiJsonlBuffer (.jsonl.br), chunkPjskScenario (8-line stride 6), and chunkPersonasToLore parse cleanly', () => {
  const rawJsonl =
    JSON.stringify({
      id: 'ev_1',
      story_id: 'event_145',
      story: '荆棘之路',
      scenario_id: 'event_145_08',
      type: 'event',
      chars: ['晓山瑞希', '东云绘名'],
      line_start: 0,
      line_end: 7,
      text: '[荆棘之路 | 晓山瑞希, 东云绘名]\n瑞希: 对不起……绘绘。'
    }) + '\n'
  const br = zlib.brotliCompressSync(Buffer.from(rawJsonl, 'utf8'))
  const chunks = parseSekaiJsonlBuffer(br, true)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].storyId, 'event_145')
  assert.equal(chunks[0].sourceKind, 'canon_story')

  const talkData = Array.from({ length: 12 }, (_, i) => ({
    WindowDisplayName: i % 2 === 0 ? '瑞希' : '绘名',
    Body: `第 ${i + 1} 句官方对白`
  }))
  const snippets = talkData.map((_, i) => ({ Action: 1, ReferenceIndex: i }))
  const windowed = chunkPjskScenario(
    { Snippets: snippets, TalkData: talkData },
    { storyId: 'ev_test', story: '测试活动', scenarioId: 'ev_test_01', type: 'event' }
  )
  assert.equal(windowed.length, 2)
  assert.equal(windowed[0].lineStart, 0)
  assert.equal(windowed[0].lineEnd, 7)
  assert.equal(windowed[1].lineStart, 6)
  assert.equal(windowed[1].lineEnd, 11)

  const lore = chunkPersonasToLore([
    {
      name: '晓山瑞希',
      aliases: ['瑞希'],
      group: '25时',
      prompt:
        '## 说话风格\n轻快俏皮，喜欢用昵称叫绘名「绘绘」，遇到真心话时会用玩笑掩饰。\n\n## 关系背景\n在 25 时担任 MV 制作，经常在神山高校天台独自午休或等人。'
    }
  ])
  assert.equal(lore.length, 2)
  assert.equal(lore[0].sourceKind, 'worldview_lore')
})

test('AdaptiveRagRetriever performs hybrid retrieval, merges adjacent scenes, enforces maxPerStory, caches incrementally, and returns 0 on unrelated queries', async (t) => {
  const mockEmbed = await startMockEmbeddingServer()
  t.after(() => mockEmbed.close())
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-rag-ret-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const makeChunk = (overrides) => {
    const text = overrides.text
    return {
      id: overrides.id,
      chunkHash: computeChunkHash(text),
      sourceKind: overrides.sourceKind ?? 'canon_story',
      storyId: overrides.storyId ?? 'ev_145',
      story: overrides.story ?? '天台的秘密',
      scenarioId: overrides.scenarioId ?? 'ev_145_08',
      type: overrides.type ?? 'event',
      chars: overrides.chars ?? ['瑞希', '绘名'],
      lineStart: overrides.lineStart ?? 0,
      lineEnd: overrides.lineEnd ?? 7,
      text
    }
  }

  const chunks = [
    makeChunk({
      id: 'c1',
      scenarioId: 'ev_145_08',
      lineStart: 0,
      lineEnd: 7,
      text: '[天台的秘密 | 瑞希, 绘名]\n瑞希: 绘绘，其实在天台上我一直没敢说。\n绘名: 瑞希，看着我。'
    }),
    makeChunk({
      id: 'c2',
      scenarioId: 'ev_145_08',
      lineStart: 6,
      lineEnd: 13,
      text: '[天台的秘密 | 瑞希, 绘名]\n绘名: 瑞希，看着我。\n瑞希: 对不起，我还是没办法坦白心结。'
    }),
    makeChunk({
      id: 'c3',
      sourceKind: 'dialogue_voice',
      storyId: 'talk_n25',
      scenarioId: 'talk_n25_01',
      type: 'talk',
      text: '[日常对话 | 瑞希, 绘名]\n瑞希: 绘绘，放学后去天台吹风吧！\n绘名: 真是的，瑞希你又偷懒。'
    }),
    makeChunk({
      id: 'c4',
      sourceKind: 'worldview_lore',
      storyId: 'persona:瑞希',
      scenarioId: 'persona:瑞希',
      type: 'persona',
      text: '[晓山瑞希 · 关系设定]\n瑞希称呼东云绘名为绘绘，常在神山高校天台独处。'
    }),
    makeChunk({
      id: 'c5',
      storyId: 'ev_wxs',
      scenarioId: 'ev_wxs_01',
      chars: ['笑梦', '宁宁'],
      text: '[游乐园 | 笑梦, 宁宁]\n笑梦: Wonderhoy！今天也要去游乐园！'
    })
  ]

  const client = new EmbeddingClient({
    enabled: true,
    baseUrl: mockEmbed.baseUrl,
    apiKeyEnv: 'MSS_TEST_EMBED_KEY',
    model: 'bge-m3',
    dimensions: 0,
    queryInstruct: '',
    timeoutMs: 5000,
    batchSize: 32
  })

  const retriever = new AdaptiveRagRetriever({
    chunks,
    settings: {
      enabled: true,
      model: 'bge-m3',
      cacheDir: tmpDir,
      fallbackLexical: true,
      adaptive: {
        minScore: 0.42,
        highScore: 0.62,
        relativeDropRatio: 0.72,
        elbowDropDelta: 0.08,
        minChunks: 0,
        maxChunks: 8,
        softCharBudget: 1800,
        maxCharBudget: 4800,
        maxPerStory: 2,
        mergeAdjacentGap: 4
      }
    },
    embeddingClient: client
  })

  const res = await retriever.retrieve({
    prompt: '放学后瑞希和绘名在天台聊起心结与秘密',
    stage: 'dialogue',
    cast: [{ name: '瑞希' }, { name: '绘名' }]
  })

  assert.equal(res.mode, 'hybrid')
  assert.ok(res.selectedCount >= 2)
  assert.ok(res.promptBlock.includes('严禁照抄原句'))
  // Adjacent chunks c1 (0..7) and c2 (6..13) merged into 1 continuous scene without duplicate overlap line
  assert.equal(res.sections.canonPlot.length, 1)
  const mergedLines = res.sections.canonPlot[0].text.split('\n')
  assert.equal(
    mergedLines.filter((l) => l.includes('绘名: 瑞希，看着我。')).length,
    1,
    'overlapping stride line should be deduplicated on merge'
  )

  // Second run with fresh retriever reuses disk SQ8 cache -> 0 document embedding calls!
  const callsBefore = mockEmbed.requests.length
  const retriever2 = new AdaptiveRagRetriever({
    chunks,
    settings: {
      enabled: true,
      model: 'bge-m3',
      cacheDir: tmpDir,
      fallbackLexical: true,
      adaptive: {
        minScore: 0.42,
        highScore: 0.62,
        relativeDropRatio: 0.72,
        elbowDropDelta: 0.08,
        minChunks: 0,
        maxChunks: 8,
        softCharBudget: 1800,
        maxCharBudget: 4800,
        maxPerStory: 2,
        mergeAdjacentGap: 4
      }
    },
    embeddingClient: client
  })
  await retriever2.retrieve({
    prompt: '放学后瑞希和绘名在天台聊起心结与秘密',
    stage: 'dialogue',
    cast: [{ name: '瑞希' }, { name: '绘名' }]
  })
  assert.equal(mockEmbed.requests.length, callsBefore, 'disk SQ8 cache + query LRU should avoid re-embedding')

  // Unrelated query returns 0 hits (no noise!)
  const unrelated = await retriever.retrieve({
    prompt: '宇宙飞船上的恐龙比赛',
    stage: 'cast'
  })
  assert.equal(unrelated.selectedCount, 0)
  assert.equal(unrelated.promptBlock, '')
})

test('AdaptiveRagRetriever gracefully falls back to lexical_fallback when embedding client is disabled', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-rag-lex-'))
  try {
    const text = '[天台的约定 | 瑞希, 绘名]\n瑞希: 绘绘，放学后在天台等我。'
    const retriever = new AdaptiveRagRetriever({
      chunks: [
        {
          id: 'lex1',
          chunkHash: computeChunkHash(text),
          sourceKind: 'canon_story',
          storyId: 's1',
          story: '天台的约定',
          scenarioId: 's1_01',
          type: 'event',
          chars: ['瑞希', '绘名'],
          lineStart: 0,
          lineEnd: 2,
          text
        }
      ],
      settings: {
        enabled: true,
        model: 'bge-m3',
        cacheDir: tmpDir,
        fallbackLexical: true,
        adaptive: {
          minScore: 0.42,
          highScore: 0.62,
          relativeDropRatio: 0.78,
          elbowDropDelta: 0.065,
          minChunks: 0,
          maxChunks: 6,
          softCharBudget: 1800,
          maxCharBudget: 4800,
          maxPerStory: 2,
          mergeAdjacentGap: 4
        }
      },
      embeddingClient: null
    })

    const res = await retriever.retrieve({
      prompt: '放学后瑞希和绘名在天台约定',
      stage: 'dialogue',
      cast: [{ name: '瑞希' }, { name: '绘名' }]
    })
    assert.equal(res.mode, 'lexical_fallback')
    assert.equal(res.selectedCount, 1)
    assert.ok(res.promptBlock.includes('天台的约定'))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('StoryWriter integrates Pass A/B RAG grounding, pairwiseAddress into translation, and conditional dialogue-polish', async (t) => {
  const captured = { castUser: '', dialogueUser: '', translateSystem: '', polishCalled: false }
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    const user = body.messages.find((m) => m.role === 'user')?.content ?? ''

    let reply
    if (system.includes('第一轮')) {
      captured.castUser = user
      reply = {
        title: '天台微风',
        logline: '放学后瑞希和绘名在天台聊近况',
        event: '放学后在天台聊近况',
        background: 'bg_room.jpg',
        cast: [
          { modelId: 1, name: '瑞希', role: '发起' },
          { modelId: 2, name: '绘名', role: '回应' }
        ],
        outline: ['上天台', '聊起画作', '自然收尾'],
        understanding: {
          explicitRequests: ['天台聊天'],
          implicitSubtext: '瑞希想确认绘名有没有熬夜',
          relationshipDynamic: '互相打趣又暗暗关心',
          emotionalArc: '轻快试探到温和余韵',
          canonHooks: ['神山高校天台'],
          avoidList: ['禁止说教总结']
        },
        pairwiseAddress: [{ from: '瑞希', to: '绘名', zh: '绘绘', ja: 'えななん' }],
        retrievalQueries: {
          plot: '瑞希 绘名 天台',
          voice: '瑞希 绘绘 日常对话',
          worldview: '神山高校 天台'
        }
      }
    } else if (system.includes('第二轮')) {
      captured.dialogueUser = user
      // Intentionally include 1 AI cliché so dialogue-polish triggers
      reply = {
        title: '天台微风',
        turns: [
          { speaker: '瑞希', lines: ['绘绘，其实我一直想说，谢谢你总是这么温柔。'] },
          { speaker: '绘名', lines: ['……你突然说什么肉麻话呢。'] }
        ]
      }
    } else if (system.includes('dialogue-polish')) {
      captured.polishCalled = true
      reply = {
        replacements: [{ id: 'l1', content: '绘绘，昨晚你又熬夜画画了吧？黑眼圈都出来啦。' }]
      }
    } else if (system.includes('舞台监督')) {
      reply = {
        scenes: [
          {
            id: 's1',
            fromLineId: 'l1',
            background: 'bg_room.jpg',
            ambient: 'none',
            activeCast: ['瑞希', '绘名'],
            bgm: 'bgm00003.mp3'
          }
        ],
        events: []
      }
    } else if (system.includes('精细演技导演')) {
      reply = {
        background: 'bg_room.jpg',
        bgm: 'bgm00003.mp3',
        lines: [
          { id: 'l1', facial: 'face_smile_01' },
          { id: 'l2', facial: 'face_normal_01' }
        ]
      }
    } else if (system.includes('中日翻译')) {
      captured.translateSystem = system
      reply = ['えななん、また夜更かしして描いてたでしょ？', '……いきなり何よ。']
    } else {
      throw new Error(`unexpected stage: ${system.slice(0, 40)}`)
    }

    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-writer-rag-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const text =
    '[天台的微风 | 瑞希, 绘名]\n放学后瑞希和绘名在天台吹风聊天。\n瑞希: 绘绘，风好舒服啊。'
  const retriever = new AdaptiveRagRetriever({
    chunks: [
      {
        id: 'r1',
        chunkHash: computeChunkHash(text),
        sourceKind: 'canon_story',
        storyId: 's_roof',
        story: '天台的微风',
        scenarioId: 's_roof_01',
        type: 'event',
        chars: ['瑞希', '绘名'],
        lineStart: 0,
        lineEnd: 2,
        text
      }
    ],
    settings: {
      enabled: true,
      model: 'bge-m3',
      cacheDir: tmpDir,
      fallbackLexical: true,
      adaptive: {
        minScore: 0.35,
        highScore: 0.62,
        relativeDropRatio: 0.78,
        elbowDropDelta: 0.065,
        minChunks: 0,
        maxChunks: 6,
        softCharBudget: 1800,
        maxCharBudget: 4800,
        maxPerStory: 2,
        mergeAdjacentGap: 4
      }
    },
    embeddingClient: null
  })

  const catalog = {
    get: () => ({
      models: [
        {
          id: 1,
          name: '晓山瑞希',
          shortName: '瑞希',
          path: '20mizuki_normal/20mizuki_normal.model3.json',
          motions: ['w-normal-default01'],
          facials: ['face_smile_01', 'face_normal_01'],
          defaultMotion: 'w-normal-default01',
          defaultFacial: 'face_smile_01'
        },
        {
          id: 2,
          name: '东云绘名',
          shortName: '绘名',
          path: '21ena_normal/21ena_normal.model3.json',
          motions: ['e-normal-default01'],
          facials: ['face_normal_01'],
          defaultMotion: 'e-normal-default01',
          defaultFacial: 'face_normal_01'
        }
      ],
      images: ['bg_room.jpg'],
      imageDetails: [{ file: 'bg_room.jpg', name: '房间', description: '天台' }],
      voices: [],
      bgm: ['bgm00003.mp3'],
      bgmDetails: [{ file: 'bgm00003.mp3', name: '日常', description: '日常' }]
    })
  }

  process.env.MSS_TEST_LLM_KEY = 'test-key'
  const settings = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKeyEnv: 'MSS_TEST_LLM_KEY',
    model: 'mock-model',
    temperature: 0.8,
    maxTokens: 2048,
    timeoutMs: 10_000,
    retries: 0,
    repairRounds: 0,
    pipeline: 'staged',
    jsonMode: 'off',
    translateForTts: true,
    polishDialogue: true,
    targetMinutes: 0.2,
    systemPrompt: '',
    personaDirs: [],
    personas: []
  }

  const writer = new StoryWriter(
    new LlmClient(settings, new Logger({ type: 'hidden' })),
    settings,
    catalog,
    new Logger({ type: 'hidden' }),
    [],
    retriever
  )

  const result = await writer.generate({ prompt: '放学后瑞希和绘名在天台吹风聊天', targetMinutes: 0.2 })
  assert.ok(captured.castUser.includes('天台的微风'), 'Pass A RAG injected into Stage 1')
  assert.ok(captured.dialogueUser.includes('绘绘'), 'pairwiseAddress injected into Stage 2')
  assert.ok(captured.dialogueUser.includes('天台的微风'), 'Pass B RAG injected into Stage 2')
  assert.ok(captured.translateSystem.includes('えななん'), 'JP pairwiseAddress injected into ttsTranslator')
  assert.equal(captured.polishCalled, true, 'dialogue-polish triggered on therapy cliche')

  const talks = result.story.snippets.filter((s) => s.type === 'Talk')
  assert.ok(talks[0].data.content.includes('熬夜画画'), 'accepted surgical polish replaced cliché line')
  assert.equal(result.meta.rag?.mode, 'lexical_fallback')
  assert.equal(result.meta.rag?.selectedCount, 1)
})
