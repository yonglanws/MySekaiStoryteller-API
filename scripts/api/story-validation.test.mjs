import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import { sanitizeDisplayText, validateAndFixStory } from '../../out-host/host/ai/validate.js'
import { StorySchema } from '../../out-host/common/types/Story.js'

function makeView() {
  return new CatalogView({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01', 'w-normal-greeting01'],
        facials: ['face_smile_01', 'face_sad_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 2,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-tilt01'],
        facials: ['face_smile_01', 'face_angry_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['bg_classroom.jpg'],
    imageDetails: [{ file: 'bg_classroom.jpg', name: '教室', description: '放学后的教室' }],
    voices: [],
    bgm: ['bgm00003.mp3', 'bgm00006.mp3'],
    bgmDetails: [
      { file: 'bgm00003.mp3', name: '日常', description: '轻松的日常场景' },
      { file: 'bgm00006.mp3', name: '安静', description: '安静的夜晚' }
    ]
  })
}

function makeStory(overrides = {}) {
  return {
    models: [
      {
        id: 1,
        model: '20mizuki_normal/20mizuki_normal.model3.json',
        normal_scale: 2.1,
        small_scale: 1.8,
        anchor: 0.5
      },
      {
        id: 2,
        model: '19ena_normal/19ena_normal.model3.json',
        normal_scale: 2.1,
        small_scale: 1.8,
        anchor: 0.5
      }
    ],
    images: [{ id: 1, image: 'bg_classroom.jpg' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: -100 },
          to: { side: 'Left', offset: 0 },
          motion: 'w-normal-nod01',
          facial: 'face_smile_01',
          facialFirst: true,
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 2,
          from: { side: 'Right', offset: 100 },
          to: { side: 'Right', offset: 0 },
          motion: 'w-normal-tilt01',
          facial: 'face_smile_01',
          facialFirst: true,
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'Talk',
        wait: false,
        delay: 0,
        data: {
          speaker: '晓山瑞希',
          content: '第一行\n第二行\n第三行\n第四行',
          ttsText: '',
          modelId: 1,
          actions: [
            { at: 0.1, modelId: 1, motion: 'w-normal-greeting01', facial: 'face_smile_01' },
            { at: 0.85, modelId: 1, motion: 'w-normal-nod01' }
          ]
        }
      },
      {
        type: 'Talk',
        wait: false,
        delay: 0.1,
        data: {
          speaker: '绘名',
          content: '嗯。',
          ttsText: '',
          modelId: 2,
          actions: [{ at: 0.1, modelId: 2, motion: 'W-NORMAL-TILT01', facial: 'face smile 01' }]
        }
      },
      { type: 'HideTalk', wait: true, delay: 0.2 },
      {
        type: 'LayoutClear',
        wait: true,
        delay: 0.1,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Center', offset: 100 },
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'LayoutClear',
        wait: true,
        delay: 0.1,
        data: {
          modelId: 2,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Center', offset: 100 },
          moveSpeed: 'Normal'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ],
    ...overrides
  }
}

test('normalizes paths, speaker, names and defaults ±100 enter/exit to in-place fade while keeping motion', () => {
  const { story } = validateAndFixStory(makeStory(), makeView())
  const appears = story.snippets.filter((snippet) => snippet.type === 'LayoutAppear')
  assert.deepEqual(appears[0].data.from, { side: 'Left', offset: 0 })
  assert.deepEqual(appears[1].data.from, { side: 'Right', offset: 0 })
  assert.equal(appears[0].data.to.offset, 0)
  assert.equal(appears[0].data.motion, 'w-normal-nod01')
  assert.equal(appears[1].data.motion, 'w-normal-tilt01')

  const clears = story.snippets.filter((snippet) => snippet.type === 'LayoutClear')
  assert.deepEqual(clears[0].data.to, { side: 'Left', offset: 0 })
  assert.deepEqual(clears[1].data.to, { side: 'Right', offset: 0 })
  // 退场动作不能是 default 站姿
  assert.ok(!clears[0].data.motion.includes('default'))

  const talks = story.snippets.filter((snippet) => snippet.type === 'Talk')
  const enaTalk = talks.find((snippet) => snippet.data.modelId === 2)
  assert.equal(enaTalk.data.speaker, '绘名')
  // Talk 的 ProgressBehavior=Now 不再有隐式前置栅栏：这句紧跟在绘名入场后
  // 0.4s 内重复同名动作，属于机械连打，linter 只去掉 motion、保留 facial。
  assert.equal(enaTalk.data.actions[0].motion, undefined)
  assert.equal(enaTalk.data.actions[0].facial, 'face_smile_01')

  // 模型漏写 ChangeBackgroundImage 时自动补一张，避免整片白底
  const background = story.snippets.find((snippet) => snippet.type === 'ChangeBackgroundImage')
  assert.equal(background.data.imageId, 1)
})

test('splits overlong Talk without dropping a single line', () => {
  const { story } = validateAndFixStory(makeStory(), makeView())
  const talks = story.snippets.filter((snippet) => snippet.type === 'Talk')
  assert.equal(talks.length, 3, 'first talk should split into two')
  const joined = talks
    .filter((snippet) => snippet.data.modelId === 1)
    .map((snippet) => snippet.data.content)
    .join('\n')
  assert.equal(joined, '第一行\n第二行\n第三行\n第四行')
  const actions = talks
    .filter((snippet) => snippet.data.modelId === 1)
    .flatMap((snippet) => snippet.data.actions ?? [])
  assert.equal(actions.length, 1, 'speaker keeps at most one action per line')
  assert.ok(actions.every((action) => action.at >= 0 && action.at <= 1))
})

test('remaps an invalid model id when the model path is unambiguous', () => {
  const story = makeStory()
  story.models = [{ id: 99, model: '20mizuki_normal/20mizuki_normal.model3.json' }]
  story.snippets = story.snippets.filter(
    (snippet) => !['LayoutAppear', 'Talk', 'LayoutClear'].includes(snippet.type)
  )
  story.snippets = [
    { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
    {
      type: 'LayoutAppear',
      wait: true,
      delay: 0,
      data: {
        modelId: 99,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 0 },
        motion: 'w-normal-nod01',
        facial: 'face_smile_01',
        moveSpeed: 'Normal'
      }
    },
    {
      type: 'Talk',
      wait: false,
      delay: 0,
      data: { speaker: '瑞希', content: '你好。', ttsText: '', modelId: 99 }
    },
    {
      type: 'LayoutClear',
      wait: true,
      delay: 0,
      data: {
        modelId: 99,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 100 },
        moveSpeed: 'Normal'
      }
    },
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
  ]
  const { story: fixed } = validateAndFixStory(story, makeView())
  assert.equal(fixed.models[0].id, 1)
  assert.equal(fixed.snippets.find((snippet) => snippet.type === 'Talk').data.modelId, 1)
})

test('rejects a Talk before its character appears', () => {
  const story = makeStory()
  story.snippets = [
    { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
    {
      type: 'Talk',
      wait: false,
      delay: 0,
      data: { speaker: '瑞希', content: '早。', ttsText: '', modelId: 1 }
    },
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
  ]
  assert.throws(() => validateAndFixStory(story, makeView()), /必须已入场/)
})

test('drops actions that exceed the per-line quota', () => {
  const story = makeStory()
  story.snippets = story.snippets.filter((snippet) => snippet.type !== 'Talk')
  story.snippets.splice(3, 0, {
    type: 'Talk',
    wait: false,
    delay: 0.5,
    data: {
      speaker: '瑞希',
      content: '一。',
      ttsText: '',
      modelId: 1,
      actions: [
        { at: 0.05, modelId: 1, motion: 'w-normal-greeting01' },
        { at: 0.1, modelId: 1, motion: 'w-normal-nod01' },
        { at: 0.35, modelId: 1, motion: 'w-normal-greeting01' },
        { at: 0.6, modelId: 1, motion: 'w-normal-nod01' },
        { at: 0.85, modelId: 1, motion: 'w-normal-greeting01' },
        { at: 0.95, modelId: 1, motion: 'w-normal-nod01' }
      ]
    }
  })
  const { story: fixed } = validateAndFixStory(story, makeView())
  const talk = fixed.snippets.find((snippet) => snippet.type === 'Talk')
  assert.equal(talk.data.actions.length, 1, 'speaker keeps at most one action per line')
  assert.equal(talk.data.actions[0].at, 0.05)
})

test('sanitizeDisplayText folds blank lines, strips zero-width chars, and wraps at 30 CJK cells', () => {
  assert.equal(sanitizeDisplayText('  你好\u200B  \n\n\n\uFEFF世界  '), '你好\n世界')
  const exact = '一'.repeat(30)
  assert.equal(sanitizeDisplayText(exact), exact)
  const long = '一'.repeat(35)
  const wrapped = sanitizeDisplayText(long)
  assert.equal(wrapped, `${'一'.repeat(30)}\n${'一'.repeat(5)}`)
  assert.ok(!wrapped.includes('\u200B'), 'must not leak zero-width space into content')

  // 有标点时优先在标点后折行，不把词拦腰截断
  const sentence =
    '今天也一起练习吧，然后我们再对一下明天要用的曲子，顺便把时间也定下来吧，好不好？'
  const natural = sanitizeDisplayText(sentence)
  assert.ok(natural.split('\n').every((line) => line.length <= 30))
  assert.ok(natural.split('\n')[0].endsWith('，'))
  assert.equal(natural.replace(/\n/g, ''), sentence)
})

test('BGM prompt choices skip undescribed entries but keep them valid', () => {
  const view = new CatalogView({
    models: [],
    images: [],
    imageDetails: [],
    voices: [],
    bgm: ['bgm00003.mp3', 'bgm00006.mp3'],
    bgmDetails: [
      { file: 'bgm00003.mp3', name: '日常', description: '轻松的日常场景' },
      { file: 'bgm00006.mp3', name: '安静', description: '' }
    ]
  })
  assert.ok(view.bgmList().includes('bgm00003.mp3'))
  assert.ok(!view.bgmList().includes('bgm00006.mp3'))
  assert.equal(view.canonicalBgm('bgm00006.mp3'), 'bgm00006.mp3')
})

test('BGM prompt list caps at 40 but validation keeps every registered file', () => {
  const files = Array.from({ length: 45 }, (_, index) => `bgm${String(index).padStart(5, '0')}.mp3`)
  const view = new CatalogView({
    models: [],
    images: [],
    imageDetails: [],
    voices: [],
    bgm: files,
    bgmDetails: files.map((file, index) => ({
      file,
      name: `曲 ${index}`,
      description: '剧情 BGM'
    }))
  })
  assert.equal(view.bgmPromptChoices().length, 45)
  assert.equal(view.bgmPromptChoices(40).length, 40)
  assert.equal(view.canonicalBgm(files[44]), files[44])
})

test('StorySchema accepts ChangeBgm and fills fade defaults', () => {
  const parsed = StorySchema.parse({
    models: [],
    images: [],
    snippets: [{ type: 'ChangeBgm', wait: false, delay: 0, data: { file: 'bgm00003.mp3' } }]
  })
  const snippet = parsed.snippets[0]
  assert.equal(snippet.type, 'ChangeBgm')
  if (snippet.type !== 'ChangeBgm') throw new Error('expected ChangeBgm')
  assert.equal(snippet.data.file, 'bgm00003.mp3')
  assert.equal(snippet.data.stop, false)
  assert.equal(snippet.data.fadeMs, 600)
})

test('StorySchema preserves official voiceDurationMs on Talk', () => {
  const parsed = StorySchema.parse({
    models: [],
    images: [],
    snippets: [
      {
        type: 'Talk',
        delay: 0,
        data: { speaker: '瑞希', content: '……', modelId: 1, voiceDurationMs: 2415.692 }
      }
    ]
  })
  const snippet = parsed.snippets[0]
  if (snippet.type !== 'Talk') throw new Error('expected Talk')
  assert.equal(snippet.data.voiceDurationMs, 2415.692)
})

test('keeps registered ChangeBgm cues and drops unknown files', () => {
  const story = makeStory()
  story.snippets.splice(
    1,
    0,
    { type: 'ChangeBgm', wait: false, delay: 0, data: { file: 'bgm00003.mp3', fadeMs: 800 } },
    { type: 'ChangeBgm', wait: false, delay: 0, data: { file: 'not-registered.mp3' } },
    { type: 'ChangeBgm', wait: false, delay: 0, data: { file: '', stop: true, fadeMs: 1200 } }
  )

  const { story: fixed, warnings } = validateAndFixStory(story, makeView())
  const bgms = fixed.snippets.filter((snippet) => snippet.type === 'ChangeBgm')
  assert.equal(bgms.length, 2)
  assert.equal(bgms[0].data.file, 'bgm00003.mp3')
  assert.equal(bgms[0].data.stop, false)
  assert.equal(bgms[0].data.fadeMs, 800)
  assert.equal(bgms[1].data.file, '')
  assert.equal(bgms[1].data.stop, true)
  assert.equal(bgms[1].data.fadeMs, 1200)
  assert.ok(warnings.some((warning) => warning.includes('not-registered.mp3')))
})

test('compiles top-level bgm into opening and background-change cues', () => {
  const story = makeStory()
  story.images = [
    { id: 1, image: 'bg_classroom.jpg' },
    { id: 2, image: 'bg_classroom.jpg' }
  ]
  story.snippets.splice(4, 0, {
    type: 'ChangeBackgroundImage',
    wait: false,
    delay: 0,
    data: { imageId: 2 }
  })
  story.bgm = ['bgm00003.mp3', 'bgm00006.mp3', '未登记.mp3']

  const { story: fixed, warnings } = validateAndFixStory(story, makeView())
  const bgms = fixed.snippets.filter((snippet) => snippet.type === 'ChangeBgm')
  assert.equal(bgms.length, 2)
  assert.equal(bgms[0].data.file, 'bgm00003.mp3')
  assert.equal(bgms[1].data.file, 'bgm00006.mp3')
  assert.equal(fixed.snippets[0].type, 'ChangeBgm')

  const secondBgm = fixed.snippets.findIndex(
    (snippet) => snippet.type === 'ChangeBgm' && snippet.data.file === 'bgm00006.mp3'
  )
  const secondBackground = fixed.snippets.findIndex(
    (snippet) => snippet.type === 'ChangeBackgroundImage' && snippet.data.imageId === 2
  )
  assert.ok(secondBgm >= 0 && secondBackground >= 0)
  assert.ok(secondBgm < secondBackground, 'BGM change should happen at the background cut')
  assert.ok(warnings.some((warning) => warning.includes('未登记.mp3')))
})

test('keeps configured emotion labels and clears unknown ones', () => {
  const story = makeStory()
  const talk = story.snippets.find((snippet) => snippet.type === 'Talk')
  talk.data.emotion = '开心'
  const kept = validateAndFixStory(story, makeView(), undefined, {
    emotionLabels: ['平静', '开心']
  })
  const keptTalk = kept.story.snippets.find((snippet) => snippet.type === 'Talk')
  assert.equal(keptTalk.data.emotion, '开心')

  const unknown = makeStory()
  const unknownTalk = unknown.snippets.find((snippet) => snippet.type === 'Talk')
  unknownTalk.data.emotion = '兴奋'
  const cleared = validateAndFixStory(unknown, makeView(), undefined, {
    emotionLabels: ['平静', '开心']
  })
  const clearedTalk = cleared.story.snippets.find((snippet) => snippet.type === 'Talk')
  assert.equal(clearedTalk.data.emotion, '')
})

test('preserves explicit LeftOver/RightOver walk-ins and under=true raises', () => {
  const story = makeStory()
  story.snippets[1].data.from = { side: 'LeftOver', offset: 0 }
  story.snippets[2].data.from = { side: 'Right', offset: 0, under: true }
  story.snippets[6].data.to = { side: 'RightOver', offset: 0 }
  const { story: fixed } = validateAndFixStory(story, makeView())
  const appears = fixed.snippets.filter((snippet) => snippet.type === 'LayoutAppear')
  const clears = fixed.snippets.filter((snippet) => snippet.type === 'LayoutClear')
  assert.deepEqual(appears[0].data.from, { side: 'LeftOver', offset: 0 })
  assert.deepEqual(appears[1].data.from, { side: 'Right', offset: 0, under: true })
  assert.deepEqual(clears[0].data.to, { side: 'RightOver', offset: 0 })
})

test('supports ThreeMode with three simultaneous characters and rejects four on stage', () => {
  const base = makeView()
  const threeView = new CatalogView({
    ...base.data,
    models: [
      ...base.models,
      {
        id: 3,
        name: '宵崎奏',
        shortName: '奏',
        path: '17kanade_normal/17kanade_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-nod01'],
        facials: ['face_smile_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      },
      {
        id: 4,
        name: '朝比奈真冬',
        shortName: '真冬',
        path: '18mafuyu_normal/18mafuyu_normal.model3.json',
        motions: ['w-normal-default01'],
        facials: ['face_smile_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ]
  })
  const threeStory = {
    models: [
      { id: 1, model: '20mizuki_normal/20mizuki_normal.model3.json' },
      { id: 2, model: '19ena_normal/19ena_normal.model3.json' },
      { id: 3, model: '17kanade_normal/17kanade_normal.model3.json' }
    ],
    images: [{ id: 1, image: 'bg_classroom.jpg' }],
    snippets: [
      { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Three' } },
      {
        type: 'LayoutAppear',
        wait: false,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          motion: 'w-normal-nod01',
          facial: 'face_smile_01'
        }
      },
      {
        type: 'LayoutAppear',
        wait: false,
        delay: 0,
        data: {
          modelId: 2,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          motion: 'w-normal-tilt01',
          facial: 'face_smile_01'
        }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 3,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Right', offset: 0 },
          motion: 'w-normal-nod01',
          facial: 'face_smile_01'
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '奏',
          content: '大家都在呢。',
          ttsText: '',
          modelId: 3,
          motion: '',
          facial: '',
          closeWindowOnFinish: true
        }
      },
      {
        type: 'LayoutClear',
        wait: false,
        delay: 0,
        data: { modelId: 1, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 } }
      },
      {
        type: 'LayoutClear',
        wait: false,
        delay: 0,
        data: { modelId: 2, from: { side: 'Center', offset: 0 }, to: { side: 'Center', offset: 0 } }
      },
      {
        type: 'LayoutClear',
        wait: true,
        delay: 0,
        data: { modelId: 3, from: { side: 'Right', offset: 0 }, to: { side: 'Right', offset: 0 } }
      }
    ]
  }
  const { story: validThree } = validateAndFixStory(threeStory, threeView)
  assert.equal(validThree.snippets.filter((s) => s.type === 'LayoutAppear').length, 3)

  const fourStory = structuredClone(threeStory)
  fourStory.models.push({ id: 4, model: '18mafuyu_normal/18mafuyu_normal.model3.json' })
  fourStory.snippets.splice(5, 0, {
    type: 'LayoutAppear',
    wait: true,
    delay: 0,
    data: { modelId: 4, from: { side: 'Right', offset: 0 }, to: { side: 'Right', offset: 0 } }
  })
  assert.throws(() => validateAndFixStory(fourStory, threeView), /最多三人|重叠/)
})

test('accepts all expanded official snippet types and auto-closes open effects', () => {
  const story = makeStory()
  story.snippets.splice(
    3,
    0,
    {
      type: 'PlaceInfo',
      wait: false,
      delay: 0,
      data: { place: '宫益坂女子学园 屋顶', duration: 2200 }
    },
    {
      type: 'SideFade',
      wait: true,
      delay: 0,
      data: { mode: 'Out', direction: 'LeftOut', duration: 400 }
    },
    {
      type: 'SideFade',
      wait: true,
      delay: 0,
      data: { mode: 'In', direction: 'RightIn', duration: 400 }
    },
    { type: 'SekaiIn', wait: true, delay: 0, data: { duration: 700 } },
    { type: 'SekaiOut', wait: true, delay: 0, data: { duration: 700 } },
    {
      type: 'AttachCharacterShader',
      wait: false,
      delay: 0,
      data: { modelId: 1, shader: 'hologram', level: 1 }
    },
    {
      type: 'CharacterShake',
      wait: false,
      delay: 0,
      data: { modelId: 2, axis: 'x', duration: 300, amplitude: 0.02 }
    },
    { type: 'LayoutDepth', wait: false, delay: 0, data: { modelId: 1, depth: 'Front' } },
    { type: 'CostumeChange', wait: false, delay: 0, data: { modelId: 2, costume: 'casual_01' } },
    {
      type: 'PlayScenarioEffect',
      wait: false,
      delay: 0,
      data: { effect: 'sakura', intensity: 0.6 }
    },
    { type: 'StopScenarioEffect', wait: false, delay: 0, data: { effect: 'sakura' } },
    { type: 'FullScreenText', wait: true, delay: 0, data: { text: '两天后——', duration: 2000 } },
    {
      type: 'SimpleSelectable',
      wait: true,
      delay: 0,
      data: { choices: ['继续练习', '先休息一会儿'], pickedIndex: 0 }
    },
    { type: 'SepiaIn', wait: true, delay: 0, data: { duration: 300 } },
    { type: 'SepiaOut', wait: true, delay: 0, data: { duration: 300 } },
    { type: 'BlurIn', wait: false, delay: 0, data: { duration: 300 } },
    { type: 'BlurOut', wait: false, delay: 0, data: { duration: 300 } },
    { type: 'BackgroundBlur', wait: false, delay: 0, data: { intensity: 0.4, duration: 300 } },
    { type: 'DollyZoom', wait: false, delay: 0, data: { scale: 1.12, duration: 600 } },
    { type: 'ShakeWindow', wait: false, delay: 0, data: { duration: 350, intensity: 12 } },
    { type: 'StopShakeWindow', wait: false, delay: 0, data: {} },
    { type: 'BgmVolume', wait: false, delay: 0, data: { volume: 0.5, fadeMs: 400 } },
    { type: 'Movie', wait: true, delay: 0, data: { file: 'intro.mp4', duration: 1500 } },
    // Intentionally leave FlashbackIn & sustained ShakeScreen unclosed so officialLinter closes them
    { type: 'FlashbackIn', wait: false, delay: 0, data: {} },
    { type: 'ShakeScreen', wait: false, delay: 0, data: { duration: 15000, amplitude: 0.01 } }
  )
  const { story: fixed } = validateAndFixStory(story, makeView())
  const types = new Set(fixed.snippets.map((s) => s.type))
  assert.ok(types.has('PlaceInfo'))
  assert.ok(types.has('SideFade'))
  assert.ok(types.has('SekaiIn'))
  assert.ok(types.has('SekaiOut'))
  assert.ok(types.has('AttachCharacterShader'))
  assert.ok(types.has('CharacterShake'))
  assert.ok(types.has('LayoutDepth'))
  assert.ok(types.has('CostumeChange'))
  assert.ok(types.has('PlayScenarioEffect'))
  assert.ok(types.has('SimpleSelectable'))
  assert.ok(types.has('DollyZoom'))
  assert.ok(types.has('BgmVolume'))
  assert.ok(types.has('Movie'))
  assert.ok(types.has('FlashbackOut'), 'unclosed FlashbackIn should auto-close with FlashbackOut')
  assert.ok(
    types.has('StopShakeScreen'),
    'unclosed ShakeScreen should auto-close with StopShakeScreen'
  )
})

test('keeps multi-beat actions on silent Motion snippets', () => {
  const story = makeStory()
  const motionSnippet = {
    type: 'Motion',
    wait: false,
    delay: 0,
    data: {
      modelId: 1,
      duration: 2,
      actions: [
        { at: 0, modelId: 1, motion: 'w-normal-nod01' },
        { at: 1, modelId: 1, motion: 'w-normal-greeting01' }
      ]
    }
  }
  const firstClear = story.snippets.findIndex((snippet) => snippet.type === 'LayoutClear')
  story.snippets.splice(firstClear, 0, motionSnippet)
  const { story: fixed } = validateAndFixStory(story, makeView())
  const motion = fixed.snippets.find((snippet) => snippet.type === 'Motion')
  assert.equal(
    motion.data.actions.length,
    2,
    'silent Motion sequences are not Talk and keep their beats'
  )
})

test('deduplicates simultaneous dual-actor body motions while allowing facial-only listener at at=0', () => {
  const story = makeStory()
  const talk = story.snippets.find(
    (snippet) => snippet.type === 'Talk' && snippet.data.modelId === 1
  )
  talk.data.actions = [
    { at: 0, modelId: 1, motion: 'w-normal-nod01', facial: 'face_smile_01' },
    { at: 0, modelId: 2, motion: 'w-normal-tilt01', facial: 'face_smile_01' }
  ]
  const { story: fixed } = validateAndFixStory(story, makeView())
  const fixedTalk = fixed.snippets.find(
    (snippet) => snippet.type === 'Talk' && snippet.data.modelId === 1
  )
  assert.equal(fixedTalk.data.actions.length, 1, 'simultaneous dual body motions deduplicate to 1')
  assert.equal(
    fixedTalk.data.actions[0].modelId,
    1,
    'the speaker body motion outranks a colliding listener body motion'
  )

  const storyFacialOnly = makeStory()
  const talk2 = storyFacialOnly.snippets.find(
    (snippet) => snippet.type === 'Talk' && snippet.data.modelId === 1
  )
  talk2.data.actions = [
    { at: 0, modelId: 1, motion: 'w-normal-nod01', facial: 'face_smile_01' },
    { at: 0, modelId: 2, facial: 'face_smile_01' }
  ]
  const { story: fixed2 } = validateAndFixStory(storyFacialOnly, makeView())
  const fixedTalk2 = fixed2.snippets.find(
    (snippet) => snippet.type === 'Talk' && snippet.data.modelId === 1
  )
  assert.equal(
    fixedTalk2.data.actions.length,
    2,
    'facial-only listener reaction cleanly coexists at at=0 with speaker body motion'
  )
})

test('repairs mismatched smile/joyful motion on sad apologetic lines and opening LayoutAppear', () => {
  const view = new CatalogView({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-default01', 'w-normal-glad01', 'w-normal-sigh01', 'w-normal-nod01'],
        facials: ['face_smile_01', 'face_normal_01', 'face_sad_01', 'face_trouble_01'],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_smile_01'
      }
    ],
    images: ['bg_classroom.jpg'],
    imageDetails: [{ file: 'bg_classroom.jpg', name: '教室', description: '放学后的教室' }],
    voices: [],
    bgm: [],
    bgmDetails: []
  })
  const rawStory = {
    models: [{ id: 1, model: '20mizuki_normal/20mizuki_normal.model3.json' }],
    images: [{ id: 1, image: 'bg_classroom.jpg' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          motion: '',
          facial: 'face_smile_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'Talk',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '对不起……刚才是我说得太过分了。',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-glad01', facial: 'face_smile_01' }],
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
          moveSpeed: 'Normal'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }
  const { story, warnings } = validateAndFixStory(rawStory, view)
  const appear = story.snippets.find((s) => s.type === 'LayoutAppear')
  assert.notEqual(
    appear.data.facial,
    'face_smile_01',
    'opening appear facial should not smile before sad apology'
  )
  const talk = story.snippets.find((s) => s.type === 'Talk')
  assert.notEqual(talk.data.actions[0].facial, 'face_smile_01')
  assert.notEqual(talk.data.actions[0].motion, 'w-normal-glad01')
  assert.equal(talk.data.actions[0].facial, 'face_sad_01')
  assert.equal(talk.data.actions[0].motion, 'w-normal-sigh01')
  assert.ok(warnings.some((w) => w.includes('情绪冲突')))
})

test('chof3y regression: repairs despair surprise/notice & regret angry, injects staggered listener reactions, strips ZWC while preserving Irodori emojis, and dedupes consecutive ChangeBgm', () => {
  const view = new CatalogView({
    models: [
      {
        id: 1,
        name: '晓山瑞希',
        shortName: '瑞希',
        path: '20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-sad01',
          'w-normal-sigh01',
          'w-normal-trouble01',
          'w-normal-nod01',
          'w-normal-tilthead01'
        ],
        facials: [
          'face_normal_01',
          'face_sad_01',
          'face_trouble_01',
          'face_worry_01',
          'face_closeeye_01',
          'face_surprise_01',
          'face_notice_01',
          'face_angry_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 2,
        name: '东云绘名',
        shortName: '绘名',
        path: '19ena_normal/19ena_normal_3.0_f_t06/19ena_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-sad01',
          'w-normal-sigh01',
          'w-normal-trouble01',
          'w-normal-nod01',
          'w-normal-tilthead01',
          'w-normal-forward01'
        ],
        facials: [
          'face_normal_01',
          'face_sad_01',
          'face_trouble_01',
          'face_closeeye_01',
          'face_surprise_01',
          'face_shock_01',
          'face_angry_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    images: ['bg_a000507.webp'],
    imageDetails: [{ file: 'bg_a000507.webp', name: '神山高校·连廊', description: '学校连廊' }],
    voices: [],
    bgm: ['cloud/bgm00039.mp3', 'cloud/bgm00016.mp3'],
    bgmDetails: [
      { file: 'cloud/bgm00039.mp3', name: '沉重', description: '低沉配乐' },
      { file: 'cloud/bgm00016.mp3', name: '悲伤', description: '悲伤配乐' }
    ]
  })

  const chof3yLike = {
    models: [
      { id: 1, model: view.models[0].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 },
      { id: 2, model: view.models[1].path, normal_scale: 2.1, small_scale: 1.8, anchor: 0.5 }
    ],
    images: [{ id: 1, image: 'bg_a000507.webp' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
      {
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: 'cloud/bgm00039.mp3', stop: false, fadeMs: 600 }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          motion: '',
          facial: 'face_worry_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 2,
          from: { side: 'Right', offset: 0 },
          to: { side: 'Right', offset: 0 },
          motion: '',
          facial: 'face_trouble_01',
          moveSpeed: 'Normal'
        }
      },
      // Duplicate consecutive ChangeBgm (same file)
      {
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: 'cloud/bgm00039.mp3', stop: false, fadeMs: 600 }
      },
      // Mizuki speaks 4 consecutive lines -> Ena (listener modelId=2) must receive staggered reactions!
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '（只要多停顿半秒的措辞，只要一闪而过的犹豫眼神……\u200B\n我全都会察觉到的。）',
          ttsText: '😮‍💨ほんの少し言葉に詰まる間も\u200B、ボクには全部、分かっちゃうんだ。',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-sad01', facial: 'face_sad_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '（那种因为顾虑才滋生出来的“温柔”……）',
          ttsText: 'そんな、気を遣って生まれてしまう「優しさ」が……🥺',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, facial: 'face_notice_01' }]
        }
      },
      {
        type: 'Move',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          motion: '',
          facial: 'face_surprise_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: 'cloud/bgm00016.mp3', stop: false, fadeMs: 600 }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '我就觉得快要窒息了。我根本受不了那个样子……！',
          ttsText: '息が詰まりそうになるんだよ。😭 そんなの、ボクには耐えられないよ……！',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-sad01', facial: 'face_surprise_01' }]
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '可我还是……没办法面对这样的现实。',
          ttsText: 'でもボクはやっぱり……この現実と、向き合うことができないんだ。😭',
          emotion: '伤心',
          modelId: 1,
          actions: [{ at: 0, modelId: 1, motion: 'w-normal-trouble01', facial: 'face_surprise_01' }]
        }
      },
      // Ena tearful regret line wrongly using face_angry_01
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '绘名',
          content: '为什么我什么都没能说出口啊……！！',
          ttsText: 'なんで私、😭何も言えなかったの……！！',
          emotion: '伤心',
          modelId: 2,
          closeWindowOnFinish: true,
          actions: [{ at: 0, modelId: 2, motion: 'w-normal-sad01', facial: 'face_angry_01' }]
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }

  const { story } = validateAndFixStory(chof3yLike, view)

  // 1) Consecutive duplicate ChangeBgm removed, distinct BGM preserved
  const bgms = story.snippets.filter((s) => s.type === 'ChangeBgm')
  assert.deepEqual(
    bgms.map((b) => b.data.file),
    ['cloud/bgm00039.mp3', 'cloud/bgm00016.mp3']
  )

  // 2) Zero-width chars stripped from content & ttsText, while Irodori emojis are PRESERVED!
  const talks = story.snippets.filter((s) => s.type === 'Talk')
  for (const t of talks) {
    assert.ok(!/[\u200B\uFEFF]/.test(t.data.content), 'no ZWC in content')
    assert.ok(!/[\u200B\uFEFF]/.test(t.data.ttsText), 'no ZWC in ttsText')
  }
  assert.ok(talks[0].data.ttsText.includes('😮‍💨'), 'Irodori ZWJ emoji must be preserved in ttsText')
  assert.ok(talks[1].data.ttsText.includes('🥺'), 'Irodori emoji must be preserved in ttsText')
  assert.ok(talks[2].data.ttsText.includes('😭'), 'Irodori emoji must be preserved in ttsText')

  // 3) Despair surprise/notice, Move surprise, and regret angry facials all repaired
  assert.notEqual(talks[1].data.actions[0].facial, 'face_notice_01')
  assert.notEqual(talks[2].data.actions[0].facial, 'face_surprise_01')
  assert.notEqual(talks[3].data.actions[0].facial, 'face_surprise_01')
  assert.notEqual(talks[4].data.actions[0].facial, 'face_angry_01')
  const moveSnippet = story.snippets.find((s) => s.type === 'Move')
  assert.notEqual(moveSnippet.data.facial, 'face_surprise_01')

  // 4) Official PJSK listener reactivity: skips inner monologues (talks 0..1), injects clean at: 0 facial-only
  //    reactions ONLY when listener is idle across >=3..4 non-monologue lines (0 mid-line staggered body motions!)
  const listenerActs = talks
    .filter((t) => t.data.modelId === 1)
    .flatMap((t) => (t.data.actions ?? []).filter((a) => a.modelId === 2))
  assert.ok(
    listenerActs.every((a) => a.at === 0 && !a.motion),
    `listener auto-reactions must be at: 0 facial-only without mid-line body motion spam, got ${JSON.stringify(listenerActs)}`
  )
  assert.equal(
    (talks[0].data.actions ?? []).filter((a) => a.modelId === 2).length,
    0,
    'listener must not react to inner monologue'
  )
  assert.equal(
    (talks[1].data.actions ?? []).filter((a) => a.modelId === 2).length,
    0,
    'listener must not react to inner monologue'
  )
  // Also verify 4 consecutive non-monologue lines DO inject a clean at: 0 facial-only reaction
  const longSpeech = structuredClone(chof3yLike)
  longSpeech.snippets.splice(
    11,
    0,
    {
      type: 'Talk',
      wait: true,
      delay: 0,
      data: {
        speaker: '瑞希',
        content: '大家一定会为了不伤害我，拼命装作什么都没发生过。',
        emotion: '伤心',
        modelId: 1,
        actions: [{ at: 0, modelId: 1, motion: 'w-normal-sad01', facial: 'face_sad_01' }]
      }
    },
    {
      type: 'Talk',
      wait: true,
      delay: 0,
      data: {
        speaker: '瑞希',
        content: '一想到那样，我就根本受不了……！',
        emotion: '伤心',
        modelId: 1,
        actions: [{ at: 0, modelId: 1, motion: 'w-normal-tilthead01', facial: 'face_sad_01' }]
      }
    }
  )
  const { story: longFixed, warnings: longWarnings } = validateAndFixStory(longSpeech, view)
  const longTalks = longFixed.snippets.filter((s) => s.type === 'Talk')
  const longListenerActs = longTalks
    .filter((t) => t.data.modelId === 1)
    .flatMap((t) => (t.data.actions ?? []).filter((a) => a.modelId === 2))
  assert.ok(
    longListenerActs.length >= 1,
    `expected >=1 at: 0 facial-only listener reaction across 4 non-monologue lines, got ${longListenerActs.length}`
  )
  assert.ok(
    longListenerActs.every((a) => a.at === 0 && !a.motion && Boolean(a.facial)),
    'all injected listener reactions must be at: 0 facial-only'
  )
  // Unrelated tilthead motion on heartbroken sad line must be repaired away from tilthead
  const heartbrokenTalk = longTalks.find((t) => t.data.content.includes('根本受不了'))
  assert.ok(heartbrokenTalk)
  assert.notEqual(
    heartbrokenTalk.data.actions?.[0]?.motion,
    'w-normal-tilthead01',
    'sad/heartbroken line must not keep unrelated tilthead motion'
  )
  assert.ok(longWarnings.some((w) => w.includes('听者')))
})

test('validateAndFixStory accepts Wait snippets and preserves top-level opening bgm when mid-story ChangeBgm exists', () => {
  const view = makeView()
  const raw = {
    models: [{ id: 1, model: '20mizuki_normal/20mizuki_normal.model3.json' }],
    images: [{ id: 1, image: 'bg_classroom.jpg' }],
    bgm: ['bgm00003.mp3'],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          motion: '',
          facial: 'face_normal_01',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '今天也要加油呢。',
          ttsText: '今日も頑張ろうね。😊',
          modelId: 1
        }
      },
      {
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: 'bgm00006.mp3', stop: false, fadeMs: 600 }
      },
      {
        type: 'Wait',
        wait: true,
        delay: 0,
        data: { duration: 1.2 }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '……安静下来了。',
          ttsText: '……静かになったね。😮‍💨',
          modelId: 1,
          closeWindowOnFinish: true
        }
      },
      {
        type: 'Wait',
        wait: true,
        delay: 0,
        data: { duration: 900 }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
    ]
  }

  const { story } = validateAndFixStory(raw, view)
  const bgms = story.snippets.filter((s) => s.type === 'ChangeBgm')
  assert.deepEqual(
    bgms.map((b) => b.data.file),
    ['bgm00003.mp3', 'bgm00006.mp3'],
    'top-level opening bgm must be preserved before first Talk when mid-story ChangeBgm is present'
  )
  const firstBgmIdx = story.snippets.findIndex((s) => s.type === 'ChangeBgm')
  const firstTalkIdx = story.snippets.findIndex((s) => s.type === 'Talk')
  assert.ok(firstBgmIdx < firstTalkIdx, 'opening BGM starts before first Talk')

  const waits = story.snippets.filter((s) => s.type === 'Wait')
  assert.equal(waits.length, 2)
  assert.equal(waits[0].data.duration, 1200, 'Wait seconds (<=10) normalized to ms')
  assert.equal(waits[1].data.duration, 900, 'Wait ms preserved verbatim')

  const talks = story.snippets.filter((s) => s.type === 'Talk')
  assert.ok(talks[1].data.ttsText.includes('😮‍💨'), 'Irodori ZWJ emoji remains intact')
})
