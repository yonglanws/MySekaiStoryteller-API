import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import ffmpeg from 'ffmpeg-static'

const require = createRequire(import.meta.url)
const realSpawn = childProcess.spawn
function moduleUnderTest() {
  let resolved
  try {
    resolved = require.resolve('../../out-host/host/record/recordMux.js')
  } catch {
    assert.fail('record-only mux helper must exist after build:host')
  }
  return require(resolved)
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mss-mux-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function run(args) {
  const child = realSpawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  let stdout = ''
  child.stdout.on('data', (bytes) => {
    stdout += bytes
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  const closed = once(child, 'close')
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const [code] = await closed
    assert.equal(code, 0, stderr)
    return { stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}
async function source(dir) {
  const videoPath = join(dir, 'source.mp4')
  await run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=128x72:rate=30',
    '-frames:v',
    '18',
    '-vf',
    "settb=1/90000,setpts='N/(30*TB)+mod(N,3)*0.007/TB'",
    '-fps_mode',
    'passthrough',
    '-enc_time_base',
    '1/90000',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    videoPath
  ])
  return videoPath
}
async function inspect(videoPath) {
  const { stdout } = await run([
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-f',
    'framehash',
    '-'
  ])
  return stdout.split('\n').filter((line) => /^0,/.test(line))
}

for (const audio of [false, true]) {
  test(
    `record mux copies VFR video without timestamp drift ${audio ? 'with AAC audio' : 'without audio'}`,
    { timeout: 30_000 },
    async (t) => {
      const { muxRecordVideo } = moduleUnderTest()
      const dir = await directory(t)
      const videoPath = await source(dir)
      const audioPath = audio ? join(dir, 'audio.wav') : undefined
      if (audio)
        await run([
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-t',
          '1',
          audioPath
        ])
      const outputPath = join(dir, 'nested', 'muxed.mp4')
      const calls = []
      t.mock.method(childProcess, 'spawn', (file, args, options) => {
        calls.push(args)
        return realSpawn(file, args, options)
      })
      const result = await muxRecordVideo({
        videoPath,
        audioPath,
        outputPath,
        audioBitrate: '128k',
        signal: new AbortController().signal
      })
      assert.deepEqual(result, {
        success: true,
        outputPath,
        fileSize: (await stat(outputPath)).size
      })
      assert.deepEqual(
        await inspect(outputPath),
        await inspect(videoPath),
        'copied packet timestamps and hashes must match'
      )
      const args = calls[0]
      assert.equal(args[args.indexOf('-c:v') + 1], 'copy')
      assert.ok(!args.includes('-r') && !args.includes('-vf'))
      assert.equal(args[args.indexOf('-movflags') + 1], '+faststart')
      const bytes = await readFile(outputPath)
      assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'))
      if (audio) {
        assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
        assert.ok(args.includes('-shortest'))
      }
      assert.ok((await stat(videoPath)).size > 0, 'mux does not own capture cleanup')
    }
  )
}

for (const operation of ['abort', 'timeout']) {
  test(
    `record mux ${operation} kills and reaps real FFmpeg before removing partial output`,
    { timeout: 30_000 },
    async (t) => {
      const { muxRecordVideo } = moduleUnderTest()
      const dir = await directory(t)
      const videoPath = await source(dir)
      const outputPath = join(dir, 'cancelled.mp4')
      let child
      let closed = false
      t.mock.method(childProcess, 'spawn', (file, args, options) => {
        // Real FFmpeg, throttled and looped solely to make the cancellation race deterministic.
        const index = args.indexOf('-i')
        args = [...args.slice(0, index), '-re', '-stream_loop', '-1', ...args.slice(index)]
        child = realSpawn(file, args, options)
        child.once('close', () => {
          closed = true
        })
        return child
      })
      const controller = new AbortController()
      const pending = muxRecordVideo({
        videoPath,
        outputPath,
        audioBitrate: '128k',
        signal: controller.signal,
        timeoutMs: operation === 'timeout' ? 300 : 10_000
      })
      const rejected = assert.rejects(pending, /cancel|abort|timed out/i)
      for (let i = 0; i < 100 && !child; i++) await delay(5)
      assert.ok(child)
      await delay(80)
      if (operation === 'abort') controller.abort()
      await rejected
      assert.equal(closed, true, 'promise must settle only after FFmpeg closes its files')
      assert.ok(child.exitCode !== null || child.signalCode !== null)
      await assert.rejects(stat(outputPath), { code: 'ENOENT' })
      assert.ok((await stat(videoPath)).size > 0)
    }
  )
}

test(
  'record mux bounds noisy FFmpeg errors and removes failed outputs',
  { timeout: 30_000 },
  async (t) => {
    const { muxRecordVideo } = moduleUnderTest()
    const dir = await directory(t)
    const videoPath = join(dir, 'invalid.mp4')
    const outputPath = join(dir, 'failed.mp4')
    await writeFile(videoPath, 'not video')
    t.mock.method(childProcess, 'spawn', () =>
      realSpawn(
        process.execPath,
        ['-e', "process.stderr.write('x'.repeat(100000),()=>process.exit(1))"],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      )
    )
    await assert.rejects(
      muxRecordVideo({
        videoPath,
        outputPath,
        audioBitrate: '128k',
        signal: new AbortController().signal
      }),
      (error) => {
        assert.match(error.message, /FFmpeg|mux/i)
        assert.ok(error.message.length < 18_000, 'stderr tail must be bounded')
        return true
      }
    )
    await assert.rejects(stat(outputPath), { code: 'ENOENT' })
  }
)
