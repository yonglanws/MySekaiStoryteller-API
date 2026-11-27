import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Logger } from 'tslog'
import { WebSocket } from 'ws'
import { WsHub } from '../../out-host/host/bridge/wsHub.js'
import { createBridgeRouter } from '../../out-host/host/bridge/bridgeRoutes.js'

function buildToneWav(sampleRate = 48000, durationSec = 0.2) {
  const frames = Math.floor(sampleRate * durationSec)
  const dataBytes = frames * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000)
    buf.writeInt16LE(sample, 44 + i * 2)
  }
  return buf
}

test('Bridge exposes Rust/Node binary WS stream endpoint, /bridge/ws-bin fallback, and Rust audio/lip-sync routes', async (t) => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'mss-bridge-rust-audio-'))
  const resourcesDir = path.join(workDir, 'resources')
  fs.mkdirSync(path.join(resourcesDir, 'audio', 'bgm'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'bgm', 'bgm001.wav'), buildToneWav(48000, 0.3))

  const token = 'bridge-test-token'
  const logger = new Logger({ type: 'hidden' })
  const config = {
    rootDir: workDir,
    paths: {
      output: path.join(workDir, 'out'),
      resources: resourcesDir,
      webRenderer: path.join(workDir, 'web')
    },
    video: {
      width: 1280,
      height: 720,
      fps: 30,
      crf: 23,
      codec: 'h264',
      encoder: 'auto',
      useRustExporter: true,
      maxOutputMbps: 6.5
    },
    bgm: { enabled: false, path: '', volume: 0.2 },
    tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 30000 },
    llm: { enabled: false, baseUrl: '', timeoutMs: 30000 }
  }

  let controller = null
  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger,
      config,
      bridgeToken: token,
      allowedOutputDirs: [workDir],
      onController: (ctrl) => {
        controller = ctrl
      }
    })
  )

  const server = http.createServer(app)
  const hub = new WsHub(
    logger,
    {
      onWorkerReady() {},
      onWorkerMessage() {},
      onWorkerDisconnected() {}
    },
    token
  )
  hub.attach(server)

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  t.after(async () => {
    hub.closeAll()
    await controller?.disposeAll?.()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  // 1. /bridge/binary-stream-endpoint returns active wsUrl + token
  const epRes = await fetch(`${baseUrl}/bridge/binary-stream-endpoint`, {
    headers: { 'x-mss-bridge-token': token }
  }).then((r) => r.json())
  assert.equal(epRes.ok, true)
  assert.ok(epRes.wsUrl)

  // 2. Test Node /bridge/ws-bin binary streaming directly (unauthorized rejected, authorized writes file)
  await assert.rejects(
    new Promise((resolve, reject) => {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws-bin?token=wrong`)
      bad.once('open', () => resolve('ok'))
      bad.once('error', reject)
    })
  )

  const wsBinFile = path.join(workDir, 'ws-bin.bin')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws-bin?token=${token}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const ctrl = (obj) =>
    new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())))
      ws.send(JSON.stringify(obj))
    })

  assert.equal((await ctrl({ op: 'open-file', streamId: 1, path: wsBinFile, truncate: true })).ok, true)
  const hdr = Buffer.alloc(16)
  hdr.writeUInt32LE(1, 0)
  hdr.writeUInt8(1, 4)
  hdr.writeBigUInt64LE(4n, 8)
  const hdr0 = Buffer.alloc(16)
  hdr0.writeUInt32LE(1, 0)
  hdr0.writeUInt8(1, 4)
  hdr0.writeBigUInt64LE(0n, 8)
  ws.send(Buffer.concat([hdr0, Buffer.from('HELO')]))
  ws.send(Buffer.concat([hdr, Buffer.from('WRLD')]))
  const closed = await ctrl({ op: 'close', streamId: 1 })
  assert.equal(closed.ok, true)
  assert.equal(fs.readFileSync(wsBinFile, 'utf8'), 'HELOWRLD')
  ws.close()

  // 3. Test Rust compute-lipsync + mix-audio-plan routes
  const voiceWav = buildToneWav(48000, 0.25)
  const lipRes = await fetch(`${baseUrl}/bridge/rust/compute-lipsync?targetValueScale=1.1`, {
    method: 'POST',
    headers: { 'x-mss-bridge-token': token, 'content-type': 'application/octet-stream' },
    body: voiceWav
  }).then((r) => r.json())
  assert.equal(lipRes.ok, true)
  assert.ok(Array.isArray(lipRes.values) && lipRes.values.length >= 10)
  assert.ok(lipRes.values.some((v) => v > 0.05))

  const mixedOut = path.join(workDir, 'mixed.wav')
  const mixRes = await fetch(`${baseUrl}/bridge/rust/mix-audio-plan`, {
    method: 'POST',
    headers: { 'x-mss-bridge-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({
      durationMs: 400,
      outputPath: mixedOut,
      bgm: {
        enabled: true,
        volume: 0.5,
        cues: [{ timeMs: 0, fadeMs: 0, stop: false, relPath: '/resources/audio/bgm/bgm001.wav', volume: 1.0 }],
        volumeTweens: []
      },
      voices: [
        {
          startMs: 50,
          endMs: 300,
          audioBase64: voiceWav.toString('base64')
        }
      ]
    })
  }).then((r) => r.json())
  assert.equal(mixRes.ok, true)
  assert.equal(mixRes.outputPath, mixedOut)
  assert.ok(fs.existsSync(mixedOut) && fs.statSync(mixedOut).size > 44)
})
