import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import FakeTimers from '@sinonjs/fake-timers'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import ffmpeg from 'ffmpeg-static'

const require = createRequire(import.meta.url)
const modulePath = '../../out-host/host/record/recordEncoder.js'
const realSpawn = childProcess.spawn

function encoderModule() {
  let path
  try {
    path = require.resolve(modulePath)
  } catch {
    assert.fail('The new host recordEncoder module must exist after build:host')
  }
  delete require.cache[path]
  return require(path)
}

const cleanups = new WeakMap()
function cleanup(t, fn) {
  if (!cleanups.has(t)) {
    const tasks = []
    cleanups.set(t, tasks)
    t.after(async () => {
      for (const task of tasks.reverse()) await task()
    })
  }
  cleanups.get(t).push(fn)
}

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'msst-record-test-'))
  cleanup(t, () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function runFfmpeg(args, input) {
  const child = realSpawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdin.on('error', () => {})
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    if (input) child.stdin.end(input)
    else child.stdin.end()
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, 0, stderr)
    return { stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(directory, kind = 'mp4', { frames = 36, vfr = false } = {}) {
  const path = join(directory, `source-${kind}-${frames}-${vfr}.${kind === 'mp4' ? 'mp4' : 'webm'}`)
  const codec =
    kind === 'mp4'
      ? [
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-profile:v',
          'baseline',
          '-crf',
          '16',
          '-bf',
          '0',
          '-g',
          '6',
          '-sc_threshold',
          '0',
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof'
        ]
      : [
          '-c:v',
          kind === 'vp9' ? 'libvpx-vp9' : 'libvpx',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-b:v',
          '2M',
          '-g',
          '6',
          '-cluster_time_limit',
          '200',
          '-live',
          '1'
        ]
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=30',
    '-frames:v',
    String(frames),
    ...(vfr
      ? ['-vf', "settb=1/90000,setpts='N/(30*TB)+mod(N,3)*0.007/TB+floor(N/5)*0.015/TB'"]
      : []),
    ...codec,
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'passthrough',
    '-enc_time_base',
    kind === 'mp4' ? '1/90000' : '1/1000',
    '-f',
    kind === 'mp4' ? 'mp4' : 'webm',
    path
  ])
  return { path, bytes: await readFile(path) }
}

async function inspect(path) {
  const { stderr } = await runFfmpeg([
    '-i',
    path,
    '-map',
    '0:v:0',
    '-vf',
    'showinfo',
    '-fps_mode',
    'passthrough',
    '-f',
    'null',
    '-'
  ])
  const timestamps = [...stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([\d.e+-]+)/g)].map(
    (m) => Number(m[1])
  )
  return { stderr, timestamps }
}

function chunks(bytes) {
  const parts = []
  const sizes = [1, 7, 31, 4093, 13, 16384, 127]
  for (let offset = 0, index = 0; offset < bytes.length; index++) {
    const end = Math.min(bytes.length, offset + sizes[index % sizes.length])
    parts.push(bytes.subarray(offset, end))
    offset = end
  }
  return parts
}

async function sessionFor(t, directory, overrides = {}) {
  const session = await encoderModule().createRecordEncoding({
    directory,
    inputWidth: 160,
    inputHeight: 90,
    width: 160,
    height: 90,
    fps: 30,
    crf: 23,
    encoder: 'cpu',
    ...overrides
  })
  cleanup(t, () => session.cancel())
  return session
}

function spySpawns(t, transform = (args) => args) {
  const calls = []
  t.mock.method(childProcess, 'spawn', (file, args, options) => {
    const child = realSpawn(file, transform(args), options)
    calls.push({ args, child })
    return child
  })
  return calls
}

test(
  'real FFmpeg can encode fragmented H264 from a pipe before EOF',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { bytes } = await fixture(directory, 'mp4', { frames: 180 })
    const output = join(directory, 'streaming-proof.mp4')
    const child = realSpawn(
      ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-probesize',
        '32768',
        '-analyzeduration',
        '0',
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        '-fps_mode',
        'passthrough',
        '-enc_time_base',
        '-1',
        '-stats_period',
        '0.1',
        '-progress',
        'pipe:1',
        output
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    cleanup(t, async () => {
      child.stdin.destroy()
      child.kill('SIGKILL')
      await closed
    })
    let progress = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      progress += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdin.on('error', () => {})
    const closed = new Promise((resolve) => child.once('close', resolve))
    const midpoint = Math.floor(bytes.length * 0.8)
    let index = 0
    for (const chunk of chunks(bytes.subarray(0, midpoint))) {
      await new Promise((resolve, reject) =>
        child.stdin.write(chunk, (error) => (error ? reject(error) : resolve()))
      )
      // Progress is emitted on frames at wall-clock intervals, not while the demuxer is waiting.
      if (++index % 8 === 0) await delay(15)
    }
    for (let attempts = 0; attempts < 100 && !/frame=\s*[1-9]/.test(progress); attempts++)
      await delay(25)
    assert.match(
      progress,
      /frame=\s*[1-9]/,
      `stream should encode while capture is open: ${stderr}`
    )
    assert.equal(child.stdin.writableEnded, false)
    child.stdin.end(bytes.subarray(midpoint))
    assert.equal(await closed, 0, stderr)
    assert.match(progress, /frame=180/)
    t.diagnostic(
      `pre-EOF streaming works; final progress ${progress.slice(-280).replaceAll('\n', ' ')}`
    )
  }
)

for (const kind of ['mp4', 'vp8', 'vp9']) {
  test(
    `CPU encodes arbitrarily split ${kind} chunks to High-profile MP4`,
    { timeout: 30_000 },
    async (t) => {
      const directory = await tempDirectory(t)
      const { bytes } = await fixture(directory, kind)
      const calls = spySpawns(t)
      const session = await sessionFor(t, directory, { width: 128, height: 72 })
      const pending = chunks(bytes).map((chunk) => session.append(chunk))
      const finishing = session.finish()
      await Promise.all(pending)
      const result = await finishing
      assert.deepEqual(
        await readFile(session.inputPath),
        bytes,
        'retained capture must preserve serialized chunks exactly'
      )
      assert.equal(result.videoPath, session.outputPath)
      assert.equal(result.frameCount, 36)
      assert.ok(
        Math.abs(result.durationMs - 1200) <= 1,
        `duration must include B-frame reorder delay: ${result.durationMs}`
      )
      const media = await inspect(result.videoPath)
      assert.match(media.stderr, /Video: h264 \(High\).*yuv420p.*128x72/)
      assert.equal(media.timestamps.length, 36)
      assert.doesNotMatch(media.stderr, /Audio:/)
      const args = calls.find(({ args }) => args.includes('pipe:0')).args
      assert.equal(args[args.indexOf('-crf') + 1], '23')
      assert.equal(args[args.indexOf('-preset') + 1], 'veryfast')
      assert.ok(args.includes('-progress'))
      assert.ok(args.includes('-enc_time_base'))
      assert.ok(!args.includes('-r'))
      assert.equal(await session.finish(), result, 'finish is idempotent')
      await assert.rejects(session.append(Buffer.from('late')), /finish|closed/i)
      assert.deepEqual(
        await readFile(session.inputPath),
        bytes,
        'rejected late append must not touch the capture'
      )
    }
  )
}

test(
  'VFR timestamps survive encoding even when configured FPS differs',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { path, bytes } = await fixture(directory, 'mp4', { vfr: true })
    const source = await inspect(path)
    assert.ok(
      new Set(source.timestamps.slice(1).map((pts, i) => (pts - source.timestamps[i]).toFixed(4)))
        .size > 2
    )
    const calls = spySpawns(t)
    const session = await sessionFor(t, directory, { fps: 12 })
    for (const chunk of chunks(bytes)) await session.append(chunk)
    const result = await session.finish()
    const output = await inspect(result.videoPath)
    assert.equal(output.timestamps.length, source.timestamps.length)
    output.timestamps.forEach((pts, index) =>
      assert.ok(
        Math.abs(pts - source.timestamps[index]) < 0.001,
        `timestamp ${index}: ${pts} vs ${source.timestamps[index]}`
      )
    )
    assert.equal(result.frameCount, source.timestamps.length)
    assert.ok(
      !calls.find(({ args }) => args.includes('pipe:0')).args.includes('-vf'),
      'identity size must not add a filter'
    )
  }
)

test(
  'capture smaller than configured output is encoded at capture size without upscaling',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { bytes } = await fixture(directory, 'mp4')
    const calls = spySpawns(t)
    const session = await sessionFor(t, directory, { width: 640, height: 360 })
    for (const chunk of chunks(bytes)) await session.append(chunk)
    const result = await session.finish()
    const media = await inspect(result.videoPath)
    assert.match(
      media.stderr,
      /Video: h264 \(High\).*yuv420p.*160x90/,
      'must stay at capture size instead of upscaling to the configured output'
    )
    assert.ok(
      !calls.find(({ args }) => args.includes('pipe:0')).args.includes('-vf'),
      'capture smaller than output must not add a scale filter'
    )
  }
)

test(
  'cancel is idempotent, kills streaming process, preserves caller files and rejects finish',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const sentinel = join(directory, 'caller-owned.txt')
    await writeFile(sentinel, 'keep')
    const calls = spySpawns(t)
    const session = await sessionFor(t, directory)
    await session.append(Buffer.from('partial'))
    await Promise.all([session.cancel(), session.cancel()])
    await assert.rejects(session.finish(), /cancel/i)
    await assert.rejects(session.append(Buffer.from('late')), /cancel/i)
    assert.ok(calls.every(({ child }) => child.exitCode !== null || child.signalCode !== null))
    assert.equal(await readFile(sentinel, 'utf8'), 'keep')
    await assert.rejects(stat(session.inputPath), { code: 'ENOENT' })
    await assert.rejects(stat(session.outputPath), { code: 'ENOENT' })
  }
)

test(
  'invalid or empty media rejects finish instead of reporting a successful zero-frame video',
  { timeout: 30_000 },
  async (t) => {
    for (const input of [Buffer.alloc(0), Buffer.from('not a video')]) {
      const directory = await tempDirectory(t)
      const session = await sessionFor(t, directory)
      await session.append(input)
      await assert.rejects(session.finish(), /ffmpeg|frames|empty|invalid/i)
      await assert.rejects(session.finish(), /ffmpeg|frames|empty|invalid/i)
    }
  }
)

function options(directory, overrides = {}) {
  return {
    directory,
    inputWidth: 160,
    inputHeight: 90,
    width: 160,
    height: 90,
    fps: 30,
    crf: 23,
    encoder: 'cpu',
    ...overrides
  }
}

// Inject only GPU availability/process faults at the OS spawn boundary; fallback encoding is real.
function cpuSubstitute(args) {
  const result = []
  const hardwareOnly = new Set([
    '-tune',
    '-rc',
    '-cq',
    '-spatial-aq',
    '-temporal-aq',
    '-rc-lookahead',
    '-quality',
    '-qp_i',
    '-qp_p',
    '-qp_b',
    '-global_quality',
    '-init_hw_device',
    '-filter_hw_device'
  ])
  for (let i = 0; i < args.length; i++) {
    if (hardwareOnly.has(args[i])) {
      i++
      continue
    }
    if (args[i] === '-c:v') {
      result.push(args[i], 'libx264')
      i++
      continue
    }
    if (args[i] === '-preset') {
      result.push(args[i], 'veryfast')
      i++
      continue
    }
    result.push(args[i])
  }
  return result
}

test(
  'auto uses cached real smoke encodes in nvidia/amd/intel order, not encoder listings',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const calls = spySpawns(t, (args) =>
      args.some((a) => /^h264_(nvenc|amf|qsv)$/.test(a))
        ? ['-hide_banner', '-invalid-test-encoder']
        : args
    )
    const { createRecordEncoding } = encoderModule()
    const sessions = await Promise.all([
      createRecordEncoding(options(directory, { encoder: 'auto' })),
      createRecordEncoding(options(directory, { encoder: 'auto' }))
    ])
    sessions.forEach((session) => cleanup(t, () => session.cancel()))
    const probes = calls.filter(({ args }) => args.includes('lavfi'))
    assert.deepEqual(
      probes.map(({ args }) => args[args.indexOf('-c:v') + 1]),
      ['h264_nvenc', 'h264_amf', 'h264_qsv']
    )
    for (const { args } of probes) {
      assert.ok(args.includes('-frames:v'), 'smoke tests must really encode frames')
      assert.ok(!args.includes('-encoders'))
      assert.ok(args.includes('high'))
      const source = args[args.indexOf('-i') + 1]
      const dimensions = /^color=size=(\d+)x(\d+):rate=30$/.exec(source)
      assert.ok(dimensions, `smoke input should be a lavfi color source: ${source}`)
      assert.ok(Number(dimensions[1]) >= 256, `hardware smoke width is too small: ${source}`)
      assert.equal(source, 'color=size=640x360:rate=30')
    }
    assert.equal(
      calls.filter(({ args }) => args.includes('pipe:0') && args.includes('libx264')).length,
      2
    )
  }
)

test(
  'explicit unavailable GPU logs CPU fallback and still makes valid encoded output',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { bytes } = await fixture(directory)
    const warnings = []
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')))
    const calls = spySpawns(t, (args) =>
      args.includes('h264_nvenc') ? ['-hide_banner', '-invalid-test-encoder'] : args
    )
    const session = await sessionFor(t, directory, { encoder: 'nvidia' })
    await session.append(bytes)
    const result = await session.finish()
    assert.ok(calls.some(({ args }) => args.includes('lavfi') && args.includes('h264_nvenc')))
    assert.ok(warnings.some((warning) => /nvidia.*(CPU|libx264)/i.test(warning)))
    assert.equal(result.frameCount, 36)
    assert.equal((await inspect(result.videoPath)).timestamps.length, 36)
  }
)

test(
  'GPU failure after a successful smoke test falls back from exact retained VFR capture',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const source = await fixture(directory, 'mp4', { frames: 60, vfr: true })
    const calls = spySpawns(t, (args) => {
      if (!args.includes('h264_nvenc')) return args
      return args.includes('lavfi')
        ? cpuSubstitute(args)
        : ['-hide_banner', '-invalid-test-encoder']
    })
    const session = await sessionFor(t, directory, { encoder: 'nvidia', crf: 19 })
    for (const chunk of chunks(source.bytes)) await session.append(chunk)
    const result = await session.finish()
    assert.deepEqual(await readFile(session.inputPath), source.bytes)
    assert.equal(result.frameCount, 60)
    const fallback = calls.find(({ args }) => args.includes(session.inputPath))
    assert.ok(fallback, 'failed streaming hardware must replay retained capture with CPU')
    assert.ok(fallback.args.includes('libx264'))
    assert.equal(fallback.args[fallback.args.indexOf('-crf') + 1], '19')
    const gpu = calls.find(
      ({ args }) => args.includes('h264_nvenc') && args.includes('pipe:0')
    ).args
    for (const [flag, value] of [
      ['-preset', 'p4'],
      ['-tune', 'hq'],
      ['-rc', 'vbr'],
      ['-cq', '19'],
      ['-b:v', '0'],
      ['-bf', '3'],
      ['-spatial-aq', '1'],
      ['-temporal-aq', '1']
    ]) {
      assert.equal(gpu[gpu.indexOf(flag) + 1], value, flag)
    }
    const inputMedia = await inspect(source.path)
    const outputMedia = await inspect(result.videoPath)
    outputMedia.timestamps.forEach((pts, index) =>
      assert.ok(Math.abs(pts - inputMedia.timestamps[index]) < 0.001)
    )
  }
)

test(
  'early clean hardware exit cannot silently truncate the recording',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { bytes } = await fixture(directory, 'mp4', { frames: 180 })
    const calls = spySpawns(t, (args) => {
      if (!args.includes('h264_nvenc')) return args
      const translated = cpuSubstitute(args)
      if (!args.includes('lavfi')) translated.splice(-1, 0, '-frames:v', '6')
      return translated
    })
    const session = await sessionFor(t, directory, { encoder: 'nvidia' })
    const live = calls.find(({ args }) => args.includes('pipe:0')).child
    const closed = new Promise((resolve) => live.once('close', resolve))
    const midpoint = Math.floor(bytes.length * 0.8)
    await session.append(bytes.subarray(0, midpoint))
    assert.equal(await closed, 0, 'fault injection produces a clean but premature exit')
    await session.append(bytes.subarray(midpoint))
    const result = await session.finish()
    assert.equal(result.frameCount, 180, 'premature exit requires retained-source replay')
    assert.equal(calls.filter(({ args }) => args.includes(session.inputPath)).length, 1)
  }
)

test(
  'CPU encoder closing before finish is not allowed to report a truncated success',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { bytes } = await fixture(directory)
    const calls = spySpawns(t, (args) => [...args.slice(0, -1), '-frames:v', '6', args.at(-1)])
    const session = await sessionFor(t, directory)
    const child = calls[0].child
    const closed = new Promise((resolve) => child.once('close', resolve))
    await session.append(bytes).catch(() => {})
    assert.equal(await closed, 0)
    await assert.rejects(session.finish(), /closed|capture|EOF|pipe/i)
  }
)

test(
  'cancel during CPU fallback kills it and finish never resolves successfully',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { bytes } = await fixture(directory)
    let fallbackStarted
    const started = new Promise((resolve) => {
      fallbackStarted = resolve
    })
    const calls = spySpawns(t, (args) => {
      if (args.includes('h264_nvenc'))
        return args.includes('lavfi')
          ? cpuSubstitute(args)
          : ['-hide_banner', '-invalid-test-encoder']
      if (!args.includes('pipe:0') && args.includes('libx264')) {
        fallbackStarted()
        return ['-hide_banner', '-nostdin', '-f', 'h264', '-i', 'pipe:0', '-f', 'null', '-']
      }
      return args
    })
    const session = await sessionFor(t, directory, { encoder: 'nvidia' })
    await session.append(bytes)
    const finishing = session.finish()
    const rejected = assert.rejects(finishing, /cancel/i)
    await Promise.race([started, delay(3000).then(() => assert.fail('CPU fallback never started'))])
    await session.cancel()
    await rejected
    assert.ok(calls.every(({ child }) => child.exitCode !== null || child.signalCode !== null))
    await assert.rejects(stat(session.outputPath), { code: 'ENOENT' })
  }
)

test(
  'append disk failures are latched without unhandled rejection and block finish',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const session = await sessionFor(t, directory)
    await rm(session.inputPath)
    await mkdir(session.inputPath)
    session.append(Buffer.from('ignored promise'))
    await delay(50)
    await assert.rejects(session.finish(), /EISDIR|EPERM|illegal operation/i)
    await rm(session.inputPath, { recursive: true })
  }
)

test('invalid dimensions and encoder choices fail before creating files or subprocesses', async (t) => {
  const directory = await tempDirectory(t)
  const { createRecordEncoding } = encoderModule()
  const calls = spySpawns(t)
  for (const invalid of [
    { width: 127 },
    { height: 0 },
    { inputWidth: NaN },
    { fps: 0 },
    { crf: Infinity },
    { encoder: 'bogus' }
  ]) {
    await assert.rejects(
      createRecordEncoding(options(directory, invalid)).then(async (session) => {
        await session.cancel()
      }),
      /invalid|even|positive|encoder|crf/i
    )
  }
  assert.equal(calls.length, 0)
  assert.deepEqual(await readdir(directory), [])
})

test(
  'idle watchdog terminates a stalled encoder and prevents late success',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const calls = spySpawns(t)
    const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanup(t, () => clock.uninstall())
    const session = await sessionFor(t, directory)
    await clock.tickAsync(126_000)
    await assert.rejects(session.finish(), /timeout|empty/i)
    assert.ok(calls.every(({ child }) => child.killed))
  }
)

test(
  'fragmented progress lines still report the exact encoded frame count',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    const { bytes } = await fixture(directory)
    const calls = spySpawns(t)
    const session = await sessionFor(t, directory)
    const stdout = calls[0].child.stdout
    const emit = stdout.emit
    t.mock.method(stdout, 'emit', function (event, ...args) {
      if (event !== 'data') return emit.call(this, event, ...args)
      for (const byte of args[0]) emit.call(this, 'data', Buffer.from([byte]))
      return true
    })
    await session.append(bytes)
    const result = await session.finish()
    assert.equal(result.frameCount, 36)
    assert.equal(result.durationMs, 1200)
  }
)

test(
  'spawn failure is observed and bounded stderr cannot exhaust error messages',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    t.mock.method(childProcess, 'spawn', () =>
      realSpawn(join(directory, 'missing-ffmpeg'), [], { stdio: ['pipe', 'pipe', 'pipe'] })
    )
    const session = await sessionFor(t, directory)
    await session.append(Buffer.from('header')).catch(() => {})
    await assert.rejects(session.finish(), /ENOENT|closed|pipe/i)
  }
)

test('noisy FFmpeg failure keeps only a bounded stderr tail', { timeout: 30_000 }, async (t) => {
  const directory = await tempDirectory(t)
  let child
  t.mock.method(childProcess, 'spawn', () => {
    child = realSpawn(
      process.execPath,
      [
        '-e',
        "process.stderr.write('x'.repeat(1024 * 1024) + 'tail-marker', () => process.exit(1))"
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return child
  })
  const session = await sessionFor(t, directory)
  const closed = new Promise((resolve) => child.once('close', resolve))
  await session.append(Buffer.from('header')).catch(() => {})
  await closed
  await assert.rejects(session.finish(), (error) => {
    assert.match(error.message, /tail-marker/)
    assert.ok(error.message.length < 17 * 1024)
    return true
  })
})

test(
  'finish watchdog kills a child which consumes input but never exits',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    let child
    t.mock.method(childProcess, 'spawn', () => {
      child = realSpawn(
        process.execPath,
        [
          '-e',
          "process.stdin.resume(); setInterval(() => process.stdout.write('frame=1\\nout_time_us=0\\n'), 100)"
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      return child
    })
    const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanup(t, () => clock.uninstall())
    const session = await sessionFor(t, directory)
    await session.append(Buffer.from('header'))
    const rejected = assert.rejects(session.finish(), /timeout|timed out/i)
    await clock.tickAsync(126_000)
    await rejected
    assert.ok(child.killed)
  }
)

test(
  'append really waits for pipe backpressure and cancel unblocks queued work',
  { timeout: 30_000 },
  async (t) => {
    const directory = await tempDirectory(t)
    let stalled
    t.mock.method(childProcess, 'spawn', () => {
      stalled = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      return stalled
    })
    const session = await sessionFor(t, directory)
    let settled = false
    const pending = session.append(Buffer.alloc(4 * 1024 * 1024)).finally(() => {
      settled = true
    })
    const rejected = assert.rejects(pending, /cancel|pipe|closed|EPIPE|EOF/i)
    await delay(100)
    assert.equal(settled, false, 'append must not resolve while ffmpeg is not consuming stdin')
    await session.cancel()
    await rejected
    assert.ok(stalled.killed)
  }
)
