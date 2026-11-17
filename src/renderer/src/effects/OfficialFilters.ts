import { Filter, Texture, WRAP_MODES, type FilterSystem, type RenderTexture } from 'pixi.js'

const OFFICIAL_VERTEX = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform vec4 inputSize;
uniform vec4 outputFrame;

varying vec2 vTextureCoord;
varying vec2 vNormalizedCoord;
varying vec2 vMaxCoord;

void main(void) {
  vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
  gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);
  vNormalizedCoord = aVertexPosition;
  vMaxCoord = max(vec2(0.0), (outputFrame.zw * inputSize.zw) - inputSize.zw * 0.5);
}
`

const TONE_MONOCHROME_FRAG = `
precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec3 uMonochrome;
uniform vec3 uToneColor;
uniform float uInfluence;

void main(void) {
  vec4 c = texture2D(uSampler, vTextureCoord);
  if (c.a <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 rgb = c.rgb / c.a;
  float lum = dot(rgb, uMonochrome);
  vec3 toned = uToneColor * lum;
  vec3 outRgb = mix(rgb, toned, clamp(uInfluence, 0.0, 1.0));
  gl_FragColor = vec4(outRgb * c.a, c.a);
}
`

export const FLASHBACK_MONOCHROME: [number, number, number] = [0.5, 0.5, 0.5]
export const FLASHBACK_TONE_COLOR: [number, number, number] = [0.5, 0.5, 0.5]
export const FLASHBACK_INFLUENCE = 0.5

export const SEPIA_MONOCHROME: [number, number, number] = [0.298912, 0.586611, 0.114478]
export const SEPIA_TONE_COLOR: [number, number, number] = [1.07, 0.74, 0.43]
export const SEPIA_INFLUENCE = 0.75

/**
 * Flashback (`EffectType 9/10`) 与 Sepia (`EffectType 27/28`) 共用的单色染色后处理滤镜。
 * 数值 1:1 对齐 `sse-render/src/shaders.wgsl`。
 */
export class ToneMonochromeFilter extends Filter {
  private readonly baseInfluence: number

  constructor(
    monochrome: [number, number, number],
    toneColor: [number, number, number],
    influence: number,
    intensity = 1
  ) {
    super(OFFICIAL_VERTEX, TONE_MONOCHROME_FRAG, {
      uMonochrome: new Float32Array(monochrome),
      uToneColor: new Float32Array(toneColor),
      uInfluence: influence * Math.max(0, Math.min(1, intensity))
    })
    this.baseInfluence = influence
  }

  get intensity(): number {
    return this.baseInfluence > 0 ? (this.uniforms.uInfluence as number) / this.baseInfluence : 0
  }

  set intensity(value: number) {
    this.uniforms.uInfluence = this.baseInfluence * Math.max(0, Math.min(1, value))
  }
}

export class FlashbackFilter extends ToneMonochromeFilter {
  constructor(intensity = 1) {
    super(FLASHBACK_MONOCHROME, FLASHBACK_TONE_COLOR, FLASHBACK_INFLUENCE, intensity)
  }
}

export class SepiaFilter extends ToneMonochromeFilter {
  constructor(intensity = 1) {
    super(SEPIA_MONOCHROME, SEPIA_TONE_COLOR, SEPIA_INFLUENCE, intensity)
  }
}

export const HOLOGRAM_LINE_INITIAL = 0.86
export const HOLOGRAM_SUB_ALPHA_INITIAL = 0.7764706
export const HOLOGRAM_INFLUENCE = 0.6
export const HOLOGRAM_MONOCHROME: [number, number, number] = [0.2, 0.45, 0.35]
export const HOLOGRAM_TONE_RATIO: [number, number, number] = [0.9, 1.2, 1.15]
export const HOLOGRAM_LINE_GAIN = 0.07
export const HOLOGRAM_SCROLL_PER_SEC = 0.1 / 20.0
export const HOLOGRAM_SUB_TEX_SCALE = 0.25

const HOLOGRAM_FRAG = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vNormalizedCoord;

uniform sampler2D uSampler;
uniform sampler2D uSubTex;
uniform float uHasHoloTex;
uniform float uLine;
uniform float uSubAlpha;
uniform float uScroll;
uniform float uInfluence;
uniform float uLineGain;
uniform vec3 uMonochrome;
uniform vec3 uToneRatio;
uniform float uMonitorMode;

void main(void) {
  vec4 c = texture2D(uSampler, vTextureCoord);
  if (c.a <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 straight = c.rgb / c.a;
  vec3 monoWeights = mix(uMonochrome, vec3(0.24, 0.46, 0.30), uMonitorMode);
  vec3 toneRatio = mix(uToneRatio, vec3(0.88, 1.08, 1.25), uMonitorMode);
  float lum = dot(straight, monoWeights);
  vec3 rgb = mix(straight, toneRatio * lum, clamp(uInfluence, 0.0, 1.0));

  float scan = 0.0;
  if (uHasHoloTex > 0.5) {
    vec2 subUv = vec2(
      fract(vNormalizedCoord.x * ${HOLOGRAM_SUB_TEX_SCALE.toFixed(4)}),
      fract((1.0 - vNormalizedCoord.y) * ${HOLOGRAM_SUB_TEX_SCALE.toFixed(4)} + uScroll)
    );
    scan = texture2D(uSubTex, subUv).r;
  } else {
    float wave = sin((vNormalizedCoord.y * 0.25 + uScroll) * 628.31853);
    scan = 0.5 + 0.5 * wave;
  }

  float threshold = mix(uLine, 0.92, uMonitorMode * 0.5);
  if (threshold >= scan) {
    rgb += vec3(scan * uLineGain);
  }

  float outAlpha = c.a * clamp(uSubAlpha, 0.0, 1.0);
  gl_FragColor = vec4(rgb * outAlpha, outAlpha);
}
`

export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `Sekai/Live2D/Live2DHologram` (`EffectType 22`) 1:1 Pixi v7 着色器 + 虚拟时钟确定性状态机。
 */
export class Live2DHologramShaderFilter extends Filter {
  private readonly rand: () => number
  private elapsedSec = 0
  private countdown: number
  private line = HOLOGRAM_LINE_INITIAL
  private subAlpha = HOLOGRAM_SUB_ALPHA_INITIAL

  constructor(options: { holoTexture?: Texture; monitor?: boolean; seed?: number } = {}) {
    const validHolo =
      options.holoTexture && options.holoTexture.valid && options.holoTexture.baseTexture?.valid
        ? options.holoTexture
        : null
    const whiteFallback =
      Texture.WHITE && Texture.WHITE.valid && Texture.WHITE.baseTexture?.valid
        ? Texture.WHITE
        : Texture.EMPTY
    const tex = validHolo ?? whiteFallback
    if (validHolo) {
      validHolo.baseTexture.wrapMode = WRAP_MODES.REPEAT
    }
    super(OFFICIAL_VERTEX, HOLOGRAM_FRAG, {
      uSubTex: tex,
      uHasHoloTex: validHolo ? 1.0 : 0.0,
      uLine: HOLOGRAM_LINE_INITIAL,
      uSubAlpha: HOLOGRAM_SUB_ALPHA_INITIAL,
      uScroll: 0.0,
      uInfluence: HOLOGRAM_INFLUENCE,
      uLineGain: HOLOGRAM_LINE_GAIN,
      uMonochrome: new Float32Array(HOLOGRAM_MONOCHROME),
      uToneRatio: new Float32Array(HOLOGRAM_TONE_RATIO),
      uMonitorMode: options.monitor ? 1.0 : 0.0
    })
    this.rand = createMulberry32(options.seed ?? 0x51a7c0de)
    this.countdown = 0.05 + this.rand() * 0.2
  }

  setHoloTexture(texture: Texture | null): void {
    if (!texture || !texture.valid || !texture.baseTexture?.valid) {
      this.uniforms.uSubTex =
        Texture.WHITE && Texture.WHITE.valid && Texture.WHITE.baseTexture?.valid
          ? Texture.WHITE
          : Texture.EMPTY
      this.uniforms.uHasHoloTex = 0.0
      return
    }
    texture.baseTexture.wrapMode = WRAP_MODES.REPEAT
    this.uniforms.uSubTex = texture
    this.uniforms.uHasHoloTex = 1.0
  }

  setMonitorMode(monitor: boolean): void {
    this.uniforms.uMonitorMode = monitor ? 1.0 : 0.0
  }

  /** 由虚拟时钟步进（秒），严禁绑定真实 wall-clock rAF。 */
  step(dtSec: number): void {
    const dt = Math.max(0, dtSec)
    this.elapsedSec += dt
    if (this.rand() < 0.015 || this.countdown <= 0) {
      this.line = 0.6 + this.rand() * 0.2
      this.subAlpha = 0.85 + this.rand() * 0.05
      this.countdown = this.rand() * 0.5
    }
    this.countdown -= dt
    this.uniforms.uScroll = this.elapsedSec * HOLOGRAM_SCROLL_PER_SEC
    this.uniforms.uLine = this.line
    this.uniforms.uSubAlpha = this.subAlpha
  }
}

const LIVE2D_BLUR_FRAG = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vMaxCoord;

uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform float uBlur;

void main(void) {
  float b = clamp(uBlur, 1.0, 3.0);
  vec2 stepPx = inputSize.zw * b;
  vec4 acc = vec4(0.0);
  float wSum = 0.0;
  for (int ix = -3; ix <= 3; ix++) {
    for (int iy = -3; iy <= 3; iy++) {
      float fx = float(ix);
      float fy = float(iy);
      if (abs(fx) <= ceil(b) && abs(fy) <= ceil(b)) {
        vec2 o = vec2(fx, fy) * stepPx;
        float w = exp2(-0.721347511 * (fx * fx + fy * fy)) * 0.159154981;
        vec2 uv = clamp(vTextureCoord + o, vec2(0.0), vMaxCoord);
        acc += texture2D(uSampler, uv) * w;
        wSum += w;
      }
    }
  }
  gl_FragColor = wSum > 0.0 ? acc / wSum : texture2D(uSampler, vTextureCoord);
}
`

export class Live2DBlurFilter extends Filter {
  constructor(level = 1.5) {
    super(OFFICIAL_VERTEX, LIVE2D_BLUR_FRAG, {
      uBlur: Math.max(1, Math.min(3, level))
    })
    this.padding = 12
  }

  set level(value: number) {
    this.uniforms.uBlur = Math.max(1, Math.min(3, value))
  }

  get level(): number {
    return this.uniforms.uBlur as number
  }
}

const UI_GAUSSIAN_BLUR_FRAG = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vMaxCoord;

uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform float uSamplingDistance;

float weightAt(int i) {
  int k = i < 0 ? -i : i;
  if (k == 0) return 0.269;
  if (k == 1) return 0.216;
  if (k == 2) return 0.113;
  return 0.036;
}

void main(void) {
  if (uSamplingDistance <= 0.001) {
    gl_FragColor = texture2D(uSampler, vTextureCoord);
    return;
  }
  vec2 stepX = vec2(inputSize.z * uSamplingDistance, 0.0);
  vec2 stepY = vec2(0.0, inputSize.w * uSamplingDistance);
  vec4 acc = vec4(0.0);
  for (int i = -3; i <= 3; i++) {
    float w = weightAt(i) * 0.5;
    vec2 uvX = clamp(vTextureCoord + stepX * float(i), vec2(0.0), vMaxCoord);
    vec2 uvY = clamp(vTextureCoord + stepY * float(i), vec2(0.0), vMaxCoord);
    acc += texture2D(uSampler, uvX) * w;
    acc += texture2D(uSampler, uvY) * w;
  }
  gl_FragColor = acc;
}
`

export const UI_GAUSSIAN_BLUR_DEFAULT_DISTANCE = 2.8

/** 背景高斯模糊（`EffectType 44`，7-tap 十字核 `samplingDistance = 2.8`）。 */
export class UIGaussianBlurFilter extends Filter {
  constructor(samplingDistance = UI_GAUSSIAN_BLUR_DEFAULT_DISTANCE) {
    super(OFFICIAL_VERTEX, UI_GAUSSIAN_BLUR_FRAG, {
      uSamplingDistance: Math.max(0, samplingDistance)
    })
    this.padding = 16
  }

  get samplingDistance(): number {
    return this.uniforms.uSamplingDistance as number
  }

  set samplingDistance(value: number) {
    this.uniforms.uSamplingDistance = Math.max(0, value)
  }
}

const CAMERA_BLUR_FRAG = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vMaxCoord;

uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform float uSpread;

float blurWeight(int i) {
  int k = i < 0 ? -i : i;
  if (k == 0) return 0.4026;
  if (k == 1) return 0.2442;
  return 0.0545;
}

void main(void) {
  if (uSpread <= 0.001) {
    gl_FragColor = texture2D(uSampler, vTextureCoord);
    return;
  }
  vec2 stepUv = inputSize.zw * uSpread;
  vec4 acc = vec4(0.0);
  float wSum = 0.0;
  for (int ix = -2; ix <= 2; ix++) {
    float wx = blurWeight(ix);
    for (int iy = -2; iy <= 2; iy++) {
      float wy = blurWeight(iy);
      float w = wx * wy;
      vec2 uv = clamp(vTextureCoord + vec2(float(ix), float(iy)) * stepUv, vec2(0.0), vMaxCoord);
      acc += texture2D(uSampler, uv) * w;
      wSum += w;
    }
  }
  gl_FragColor = wSum > 0.0 ? acc / wSum : texture2D(uSampler, vTextureCoord);
}
`

/** 镜头 5-tap 高斯模糊（`EffectType 38/39` `BlurIn/Out`，3 次 2x 下采样等效扩展）。 */
export class CameraBlurFilter extends Filter {
  constructor(spread = 0) {
    super(OFFICIAL_VERTEX, CAMERA_BLUR_FRAG, {
      uSpread: Math.max(0, spread)
    })
    this.padding = 16
  }

  get spread(): number {
    return this.uniforms.uSpread as number
  }

  set spread(value: number) {
    this.uniforms.uSpread = Math.max(0, value)
  }

  override apply(
    filterManager: FilterSystem,
    input: RenderTexture,
    output: RenderTexture,
    clearMode: number
  ): void {
    super.apply(filterManager, input, output, clearMode)
  }
}

const DOLLY_ZOOM_FRAG = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vNormalizedCoord;
varying vec2 vMaxCoord;

uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform vec4 outputFrame;
uniform float uDistortion;
uniform float uSamplingDistance;

float weightAt(int i) {
  int k = i < 0 ? -i : i;
  if (k == 0) return 0.269;
  if (k == 1) return 0.216;
  if (k == 2) return 0.113;
  return 0.036;
}

vec2 barrelCoord(vec2 normUv) {
  vec2 d = normUv - vec2(0.5);
  vec2 distorted = vec2(0.5) + d * (1.0 + uDistortion * dot(d, d));
  vec2 clampedNorm = clamp(distorted, vec2(0.0), vec2(1.0));
  return clamp(clampedNorm * (outputFrame.zw * inputSize.zw), vec2(0.0), vMaxCoord);
}

void main(void) {
  vec2 baseUv = barrelCoord(vNormalizedCoord);
  if (uSamplingDistance <= 0.001) {
    gl_FragColor = texture2D(uSampler, baseUv);
    return;
  }
  vec2 stepX = vec2(inputSize.z * uSamplingDistance, 0.0);
  vec2 stepY = vec2(0.0, inputSize.w * uSamplingDistance);
  vec4 acc = vec4(0.0);
  for (int i = -3; i <= 3; i++) {
    float w = weightAt(i) * 0.5;
    acc += texture2D(uSampler, clamp(baseUv + stepX * float(i), vec2(0.0), vMaxCoord)) * w;
    acc += texture2D(uSampler, clamp(baseUv + stepY * float(i), vec2(0.0), vMaxCoord)) * w;
  }
  gl_FragColor = acc;
}
`

/** `DollyZoom` (`EffectType 45`)：径向桶形畸变 + 边缘径向柔和模糊。 */
export class DollyZoomFilter extends Filter {
  constructor(distortion = 0, samplingDistance = 0) {
    super(OFFICIAL_VERTEX, DOLLY_ZOOM_FRAG, {
      uDistortion: distortion,
      uSamplingDistance: Math.max(0, samplingDistance)
    })
  }

  get distortion(): number {
    return this.uniforms.uDistortion as number
  }

  set distortion(value: number) {
    this.uniforms.uDistortion = value
  }

  get samplingDistance(): number {
    return this.uniforms.uSamplingDistance as number
  }

  set samplingDistance(value: number) {
    this.uniforms.uSamplingDistance = Math.max(0, value)
  }
}
