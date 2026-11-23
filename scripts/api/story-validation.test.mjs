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
  assert.equal(actions.length, 2)
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
    delay: 0,
    data: {
      speaker: '瑞希',
      content: '一。',
      ttsText: '',
      modelId: 1,
      actions: [
        { at: 0.05, modelId: 1, motion: 'w-normal-nod01' },
        { at: 0.1, modelId: 1, motion: 'w-normal-greeting01' },
        { at: 0.35, modelId: 1, motion: 'w-normal-nod01' },
        { at: 0.6, modelId: 1, motion: 'w-normal-greeting01' },
        { at: 0.85, modelId: 1, motion: 'w-normal-nod01' },
        { at: 0.95, modelId: 1, motion: 'w-normal-greeting01' }
      ]
    }
  })
  const { story: fixed } = validateAndFixStory(story, makeView())
  const talk = fixed.snippets.find((snippet) => snippet.type === 'Talk')
  assert.ok(talk.data.actions.length <= 5)
  for (let index = 1; index < talk.data.actions.length; index++) {
    assert.ok(talk.data.actions[index].at - talk.data.actions[index - 1].at >= 0.2 - 1e-9)
  }
})

test('sanitizeDisplayText folds blank lines and wraps at 30 CJK cells', () => {
  assert.equal(sanitizeDisplayText('  你好  \n\n\n世界  '), '你好\n世界')
  const exact = '一'.repeat(30)
  assert.equal(sanitizeDisplayText(exact), exact)
  const long = '一'.repeat(35)
  const wrapped = sanitizeDisplayText(long)
  // 排版折行用零宽空格标记在换行前（官方正文换行没有标记）。
  assert.equal(wrapped, `${'一'.repeat(30)}\u200B\n${'一'.repeat(5)}`)

  // 有标点时优先在标点后折行，不把词拦腰截断
  const sentence =
    '今天也一起练习吧，然后我们再对一下明天要用的曲子，顺便把时间也定下来吧，好不好？'
  const natural = sanitizeDisplayText(sentence)
  assert.ok(natural.split('\n').every((line) => line.replace('\u200B', '').length <= 30))
  assert.ok(natural.split('\n')[0].replace('\u200B', '').endsWith('，'))
  assert.equal(natural.replace(/\u200B?\n/g, ''), sentence)
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
