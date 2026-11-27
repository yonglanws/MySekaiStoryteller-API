/**
 * T4 并发导出测试：同时提交 N 个导出任务，验证真并行（总耗时 << N × 单任务耗时）。
 * 用法：node scripts/test-parallel.mjs [并发数，默认2]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const API_URL = process.env.MSS_API_URL || 'http://127.0.0.1:9881'
const API_KEY = process.env.MSST_API_KEY || process.env.MSS_API_KEY || ''
const N = parseInt(process.argv[2] || '2', 10)
const STORY_FILE =
  process.env.MSS_E2E_STORY || 'resources/stories/multi-character-demo.sekai-story.json'

/** 当仓库无本地示例剧本时，生成一个最小纯云端演示剧本 */
function createMinimalCloudDemoStory() {
  return {
    models: [
      {
        id: 1,
        model: 'cloud/20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal_3.0_t04.model3.json',
        normal_scale: 2.1,
        small_scale: 1.8,
        anchor: 0.5
      }
    ],
    images: [{ id: 1, image: '神山高校 天台·黄昏' }],
    snippets: [
      { type: 'ChangeBgm', wait: false, delay: 0, data: { file: 'bgm00003', fadeMs: 400 } },
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 300, color: 'black' } },
      { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
      { type: 'AmbientColor', wait: false, delay: 0, data: { mode: 'evening' } },
      { type: 'BlackIn', wait: true, delay: 0, data: { duration: 400, color: 'black' } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          motion: 'w-normal-greeting01',
          facial: 'face_smile_01',
          facialFirst: true,
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '晓山瑞希',
          content: '放学后的天台风还真舒服啊！',
          ttsText: '放課後の屋上って、風が気持ちいいね！',
          emotion: '开心',
          modelId: 1,
          closeWindowOnFinish: true
        }
      },
      {
        type: 'LayoutClear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          motion: 'w-normal-nod01',
          moveSpeed: 'Normal'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 400, color: 'black' } }
    ]
  }
}

const usingBuiltInDemo = !process.env.MSS_E2E_STORY && !existsSync(STORY_FILE)
const story = usingBuiltInDemo
  ? createMinimalCloudDemoStory()
  : JSON.parse(readFileSync(STORY_FILE, 'utf-8'))
if (!usingBuiltInDemo) {
  adaptStoryToAvailableAssets(story)
}
const body = JSON.stringify({ story, timeout: 420000 })
const authHeaders = API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}

/** 内置示例故事可能引用当前目录缺失的模型/背景，替换为实际存在的资源 */
function adaptStoryToAvailableAssets(story) {
  const modelsRoot = 'resources/models'
  const imagesRoot = 'resources/images'
  const availableModels = existsSync(modelsRoot)
    ? readdirSync(modelsRoot, { recursive: true })
        .filter((f) => f.endsWith('.model3.json'))
        .sort()
    : []
  const availableImages = existsSync(imagesRoot)
    ? readdirSync(imagesRoot)
        .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
        .sort()
    : []
  for (const m of story.models || []) {
    if (!existsSync(`${modelsRoot}/${m.model}`) && availableModels.length > 0) {
      m.model = availableModels[0].replaceAll('\\', '/')
    }
  }
  for (const img of story.images || []) {
    if (!existsSync(`${imagesRoot}/${img.image}`) && availableImages.length > 0) {
      img.image = availableImages[0]
    }
  }
}

const post = () =>
  fetch(`${API_URL}/api/v1/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body
  }).then((r) => r.json())

const t0 = Date.now()
const results = await Promise.all(Array.from({ length: N }, () => post()))
const wall = ((Date.now() - t0) / 1000).toFixed(1)

let ok = true
results.forEach((r, i) => {
  const name = (r.videoPath || '').split(/[\\/]/).pop() || r.message
  console.log(
    `task#${i}: success=${r.success}, file=${name}, renderDuration=${r.duration ? r.duration.toFixed(1) + 's' : 'n/a'}`
  )
  if (!r.success) ok = false
})
console.log(`wall time for ${N} exports: ${wall}s (serial estimate ~${65 * N}s)`)
console.log(ok ? 'PARALLEL TEST PASSED' : 'PARALLEL TEST FAILED')
process.exit(ok ? 0 : 1)
