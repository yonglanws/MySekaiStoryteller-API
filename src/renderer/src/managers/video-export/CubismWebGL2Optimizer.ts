import { Cubism4InternalModel } from 'pixi-live2d-display-advanced'
import * as cubism4Runtime from 'pixi-live2d-display-advanced/cubism4'

interface DrawableSlot {
  vBase: number
  vCount: number
  iFirst: number
  iCount: number
}

interface RendererBatchState {
  gl: WebGL2RenderingContext
  drawableCount: number
  slots: DrawableSlot[]
  totalVerts: number
  indexType: number
  indexSize: number
  posData: Float32Array
  posBuf: WebGLBuffer
  uvBuf: WebGLBuffer
  idxBuf: WebGLBuffer
  vaos: Map<WebGLProgram, WebGLVertexArrayObject>
  syncedOnce: boolean
}

interface ProgramCache {
  samplersInit: boolean
  lastMatrixFrame: number
  lastBaseR: number
  lastBaseG: number
  lastBaseB: number
  lastBaseA: number
  lastMulR: number
  lastMulG: number
  lastMulB: number
  lastMulA: number
  lastScrR: number
  lastScrG: number
  lastScrB: number
  lastScrA: number
  lastChanR: number
  lastChanG: number
  lastChanB: number
  lastChanA: number
  lastClipMatrix: Float32Array | null
}

interface ShaderSetLike {
  shaderProgram: WebGLProgram
  attributePositionLocation: number
  attributeTexCoordLocation: number
  samplerTexture0Location: WebGLUniformLocation
  samplerTexture1Location?: WebGLUniformLocation
  uniformMatrixLocation?: WebGLUniformLocation
  uniformClipMatrixLocation?: WebGLUniformLocation
  uniformChannelFlagLocation?: WebGLUniformLocation
  uniformBaseColorLocation: WebGLUniformLocation
  uniformMultiplyColorLocation: WebGLUniformLocation
  uniformScreenColorLocation: WebGLUniformLocation
}

interface CubismRendererInternal {
  gl: WebGL2RenderingContext | null
  _model: {
    getDrawableCount(): number
    getDrawableVertexCount(idx: number): number
    getDrawableVertexIndexCount(idx: number): number
    getDrawableVertexIndices(idx: number): Uint16Array
    getDrawableVertices(idx: number): Float32Array
    getDrawableVertexUvs(idx: number): Float32Array
    getDrawableRenderOrders(): Int32Array
    getDrawableDynamicFlagIsVisible(idx: number): boolean
    getDrawableDynamicFlagVertexPositionsDidChange(idx: number): boolean
    getDrawableTextureIndex(idx: number): number
    getMultiplyColor(idx: number): { R: number; G: number; B: number; A: number }
    getScreenColor(idx: number): { R: number; G: number; B: number; A: number }
    getDrawableOpacity(idx: number): number
    getDrawableBlendMode(idx: number): number
    getDrawableInvertedMaskBit(idx: number): boolean
    getDrawableCulling(idx: number): boolean
  } | null
  _clippingManager: {
    setupClippingContext(model: unknown, renderer: unknown): void
    getClippingContextListForDraw(): Array<{
      _isUsing: boolean
      _bufferIndex: number
      _layoutChannelNo: number
      _layoutBounds: { x: number; y: number; getRight(): number; getBottom(): number }
      _matrixForMask: { getArray(): Float32Array }
      _matrixForDraw: { getArray(): Float32Array }
      getClippingManager(): {
        getColorBuffer(): WebGLTexture[]
        getChannelFlagAsColor(ch: number): { R: number; G: number; B: number; A: number }
      }
    } | null>
  } | null
  _sortedDrawableIndexList: number[]
  _textures: Record<number, WebGLTexture | null>
  getModel(): CubismRendererInternal['_model']
  isUsingHighPrecisionMask(): boolean
  preDraw(): void
  isCulling(): boolean
  setIsCulling(val: boolean): void
  getModelColor(): { R: number; G: number; B: number; A: number }
  isPremultipliedAlpha(): boolean
  getMvpMatrix(): { getArray(): Float32Array }
  getClippingContextBufferForMask(): {
    _layoutChannelNo: number
    _layoutBounds: { x: number; y: number; getRight(): number; getBottom(): number }
    _matrixForMask: { getArray(): Float32Array }
    getClippingManager(): {
      getChannelFlagAsColor(ch: number): { R: number; G: number; B: number; A: number }
    }
  } | null
  setClippingContextBufferForMask(clip: unknown): void
  getClippingContextBufferForDraw(): {
    _bufferIndex: number
    _layoutChannelNo: number
    _matrixForDraw: { getArray(): Float32Array }
    getClippingManager(): {
      getColorBuffer(): WebGLTexture[]
      getChannelFlagAsColor(ch: number): { R: number; G: number; B: number; A: number }
    }
  } | null
  setClippingContextBufferForDraw(clip: unknown): void
  doDrawModel(): void
  __mssBatch?: RendererBatchState | null
  __mssBatchDisabled?: boolean
}

interface Cubism4ShaderSources {
  vertexShaderSrcSetupMask?: string
  fragmentShaderSrcsetupMask?: string
  vertexShaderSrc?: string
  fragmentShaderSrcPremultipliedAlpha?: string
  vertexShaderSrcMasked?: string
  fragmentShaderSrcMaskPremultipliedAlpha?: string
  fragmentShaderSrcMaskInvertedPremultipliedAlpha?: string
}

let installed = false
let rendererProtoPatched = false
let frameCounter = 0

const programCaches = new WeakMap<WebGLProgram, ProgramCache>()
const glShaderSetsCache = new WeakMap<WebGL2RenderingContext, ShaderSetLike[] | null>()

function compileProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string
): WebGLProgram | null {
  const vs = gl.createShader(gl.VERTEX_SHADER)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  if (!vs || !fs) return null
  gl.shaderSource(vs, vertSrc)
  gl.compileShader(vs)
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  gl.shaderSource(fs, fragSrc)
  gl.compileShader(fs)
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  const prog = gl.createProgram()
  if (!prog) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog)
    return null
  }
  return prog
}

function buildShaderSetDesc(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  masked: boolean,
  setupMask: boolean
): ShaderSetLike {
  return {
    shaderProgram: program,
    attributePositionLocation: gl.getAttribLocation(program, 'a_position'),
    attributeTexCoordLocation: gl.getAttribLocation(program, 'a_texCoord'),
    samplerTexture0Location: gl.getUniformLocation(program, 's_texture0')!,
    samplerTexture1Location: masked ? gl.getUniformLocation(program, 's_texture1')! : undefined,
    uniformMatrixLocation: setupMask ? undefined : gl.getUniformLocation(program, 'u_matrix')!,
    uniformClipMatrixLocation:
      setupMask || masked ? gl.getUniformLocation(program, 'u_clipMatrix')! : undefined,
    uniformChannelFlagLocation:
      setupMask || masked ? gl.getUniformLocation(program, 'u_channelFlag')! : undefined,
    uniformBaseColorLocation: gl.getUniformLocation(program, 'u_baseColor')!,
    uniformMultiplyColorLocation: gl.getUniformLocation(program, 'u_multiplyColor')!,
    uniformScreenColorLocation: gl.getUniformLocation(program, 'u_screenColor')!
  }
}

function getOrCreateShaderSets(gl: WebGL2RenderingContext): ShaderSetLike[] | null {
  if (glShaderSetsCache.has(gl)) {
    return glShaderSetsCache.get(gl) ?? null
  }
  const src = cubism4Runtime as unknown as Cubism4ShaderSources
  if (
    !src.vertexShaderSrcSetupMask ||
    !src.fragmentShaderSrcsetupMask ||
    !src.vertexShaderSrc ||
    !src.fragmentShaderSrcPremultipliedAlpha ||
    !src.vertexShaderSrcMasked ||
    !src.fragmentShaderSrcMaskPremultipliedAlpha ||
    !src.fragmentShaderSrcMaskInvertedPremultipliedAlpha
  ) {
    glShaderSetsCache.set(gl, null)
    return null
  }

  const p0 = compileProgram(gl, src.vertexShaderSrcSetupMask, src.fragmentShaderSrcsetupMask)
  const p1 = compileProgram(gl, src.vertexShaderSrc, src.fragmentShaderSrcPremultipliedAlpha)
  const p2 = compileProgram(gl, src.vertexShaderSrcMasked, src.fragmentShaderSrcMaskPremultipliedAlpha)
  const p3 = compileProgram(
    gl,
    src.vertexShaderSrcMasked,
    src.fragmentShaderSrcMaskInvertedPremultipliedAlpha
  )
  if (!p0 || !p1 || !p2 || !p3) {
    glShaderSetsCache.set(gl, null)
    return null
  }

  const sets: ShaderSetLike[] = [
    buildShaderSetDesc(gl, p0, false, true),
    buildShaderSetDesc(gl, p1, false, false),
    buildShaderSetDesc(gl, p2, true, false),
    buildShaderSetDesc(gl, p3, true, false),
    buildShaderSetDesc(gl, p1, false, false),
    buildShaderSetDesc(gl, p2, true, false),
    buildShaderSetDesc(gl, p3, true, false),
    buildShaderSetDesc(gl, p1, false, false),
    buildShaderSetDesc(gl, p2, true, false),
    buildShaderSetDesc(gl, p3, true, false)
  ]
  glShaderSetsCache.set(gl, sets)
  return sets
}

function getProgramCache(program: WebGLProgram): ProgramCache {
  let cache = programCaches.get(program)
  if (!cache) {
    cache = {
      samplersInit: false,
      lastMatrixFrame: -1,
      lastBaseR: NaN,
      lastBaseG: NaN,
      lastBaseB: NaN,
      lastBaseA: NaN,
      lastMulR: NaN,
      lastMulG: NaN,
      lastMulB: NaN,
      lastMulA: NaN,
      lastScrR: NaN,
      lastScrG: NaN,
      lastScrB: NaN,
      lastScrA: NaN,
      lastChanR: NaN,
      lastChanG: NaN,
      lastChanB: NaN,
      lastChanA: NaN,
      lastClipMatrix: null
    }
    programCaches.set(program, cache)
  }
  return cache
}

function sameMatrix16(a: Float32Array | null, b: Float32Array): boolean {
  if (!a || a.length !== 16) return false
  for (let i = 0; i < 16; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function createBatchState(
  gl: WebGL2RenderingContext,
  model: NonNullable<CubismRendererInternal['_model']>
): RendererBatchState | null {
  const drawableCount = model.getDrawableCount()
  if (drawableCount <= 0) return null

  const slots: DrawableSlot[] = new Array(drawableCount)
  let totalVerts = 0
  let totalIndices = 0

  for (let d = 0; d < drawableCount; d++) {
    const vCount = model.getDrawableVertexCount(d)
    const iCount = model.getDrawableVertexIndexCount(d)
    slots[d] = { vBase: totalVerts, vCount, iFirst: totalIndices, iCount }
    totalVerts += vCount
    totalIndices += iCount
  }

  if (totalVerts <= 0 || totalIndices <= 0) return null

  const wide = totalVerts > 0xffff
  const indexType = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
  const indexSize = wide ? 4 : 2
  const idxData = wide ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices)
  const uvData = new Float32Array(totalVerts * 2)
  const posData = new Float32Array(totalVerts * 2)

  for (let d = 0; d < drawableCount; d++) {
    const s = slots[d]
    const indices = model.getDrawableVertexIndices(d)
    for (let k = 0; k < s.iCount; k++) {
      idxData[s.iFirst + k] = s.vBase + indices[k]
    }
    const uvs = model.getDrawableVertexUvs(d)
    uvData.set(uvs.length > s.vCount * 2 ? uvs.subarray(0, s.vCount * 2) : uvs, s.vBase * 2)
    const verts = model.getDrawableVertices(d)
    posData.set(verts.length > s.vCount * 2 ? verts.subarray(0, s.vCount * 2) : verts, s.vBase * 2)
  }

  const posBuf = gl.createBuffer()
  const uvBuf = gl.createBuffer()
  const idxBuf = gl.createBuffer()
  if (!posBuf || !uvBuf || !idxBuf) {
    if (posBuf) gl.deleteBuffer(posBuf)
    if (uvBuf) gl.deleteBuffer(uvBuf)
    if (idxBuf) gl.deleteBuffer(idxBuf)
    return null
  }

  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
  gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW)

  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
  gl.bufferData(gl.ARRAY_BUFFER, uvData, gl.STATIC_DRAW)

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxData, gl.STATIC_DRAW)

  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

  return {
    gl,
    drawableCount,
    slots,
    totalVerts,
    indexType,
    indexSize,
    posData,
    posBuf,
    uvBuf,
    idxBuf,
    vaos: new Map(),
    syncedOnce: true
  }
}

function getOrCreateVao(
  state: RendererBatchState,
  shaderSet: ShaderSetLike
): WebGLVertexArrayObject {
  const prog = shaderSet.shaderProgram
  let vao = state.vaos.get(prog)
  if (vao) return vao

  const gl = state.gl
  vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)

  gl.bindBuffer(gl.ARRAY_BUFFER, state.posBuf)
  gl.enableVertexAttribArray(shaderSet.attributePositionLocation)
  gl.vertexAttribPointer(shaderSet.attributePositionLocation, 2, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, state.uvBuf)
  gl.enableVertexAttribArray(shaderSet.attributeTexCoordLocation)
  gl.vertexAttribPointer(shaderSet.attributeTexCoordLocation, 2, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.idxBuf)
  gl.bindVertexArray(null)
  state.vaos.set(prog, vao)
  return vao
}

function syncVertexPositions(
  state: RendererBatchState,
  model: NonNullable<CubismRendererInternal['_model']>
): void {
  const gl = state.gl
  const posData = state.posData
  const forceAll = !state.syncedOnce
  let dirty = forceAll
  for (let d = 0; d < state.drawableCount; d++) {
    if (forceAll || model.getDrawableDynamicFlagVertexPositionsDidChange(d)) {
      const s = state.slots[d]
      const verts = model.getDrawableVertices(d)
      posData.set(verts.length > s.vCount * 2 ? verts.subarray(0, s.vCount * 2) : verts, s.vBase * 2)
      dirty = true
    }
  }
  state.syncedOnce = true
  if (dirty) {
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, state.posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW)
  }
}

function releaseBatchState(renderer: CubismRendererInternal): void {
  const batch = renderer.__mssBatch
  renderer.__mssBatch = null
  if (!batch) return
  const gl = batch.gl
  try {
    for (const vao of batch.vaos.values()) {
      gl.deleteVertexArray(vao)
    }
    batch.vaos.clear()
    gl.deleteBuffer(batch.posBuf)
    gl.deleteBuffer(batch.uvBuf)
    gl.deleteBuffer(batch.idxBuf)
  } catch {
    /* context may already be lost */
  }
}

/**
 * Installs WebGL2 shared-VBO/static-UV/static-IBO, cached-VAO, and redundant GL-state
 * elision optimizations onto `CubismRenderer_WebGL` (inspired by `ournotes-player/src/live2d/drawing.js`).
 * Eliminates ~810+ `gl.bufferData` reallocations and ~18 `gl.getParameter` stalls per model per frame.
 */
function patchRendererPrototype(proto: Record<string, unknown>): boolean {
  if (rendererProtoPatched) return true
  if (!proto || typeof proto.doDrawModel !== 'function') {
    return false
  }

  const origDrawModel = proto.drawModel as (this: CubismRendererInternal) => void
  const origDoDrawModel = proto.doDrawModel as (this: CubismRendererInternal) => void
  const origRelease = proto.release as (this: CubismRendererInternal) => void

  // Skip 18x gl.getParameter() / getVertexAttrib() per model per frame in saveProfile/restoreProfile:
  // PixiJS Live2DModel._render already calls renderer.shader/geometry/state/texture.reset() around draw().
  proto.drawModel = function (this: CubismRendererInternal): void {
    const model = this.getModel()
    if (model == null) return
    const gl = this.gl
    if (!gl || typeof gl.createVertexArray !== 'function') {
      origDrawModel.call(this)
      return
    }
    this.doDrawModel()
  }

  proto.release = function (this: CubismRendererInternal): void {
    releaseBatchState(this)
    origRelease.call(this)
  }

  proto.preDraw = function (this: CubismRendererInternal): void {
    const gl = this.gl
    if (!gl) return
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.DEPTH_TEST)
    gl.frontFace(gl.CW)
    gl.enable(gl.BLEND)
    gl.colorMask(true, true, true, true)
  }

  proto.doDrawModel = function (this: CubismRendererInternal): void {
    const gl = this.gl
    const model = this.getModel()
    if (
      !gl ||
      !model ||
      typeof gl.createVertexArray !== 'function' ||
      this.__mssBatchDisabled ||
      this.isUsingHighPrecisionMask() ||
      !this.isPremultipliedAlpha()
    ) {
      origDoDrawModel.call(this)
      return
    }

    const shaderSets = getOrCreateShaderSets(gl)
    if (!shaderSets || shaderSets.length < 10) {
      this.__mssBatchDisabled = true
      origDoDrawModel.call(this)
      return
    }

    let batch = this.__mssBatch
    if (batch && (batch.gl !== gl || batch.drawableCount !== model.getDrawableCount())) {
      releaseBatchState(this)
      batch = null
    }
    if (!batch) {
      batch = createBatchState(gl, model)
      if (!batch) {
        this.__mssBatchDisabled = true
        origDoDrawModel.call(this)
        return
      }
      this.__mssBatch = batch
    }

    const currentFrameId = ++frameCounter

    // Sync changed vertices once into the shared dynamic VBO before mask + main passes
    syncVertexPositions(batch, model)

    // Per-draw-pass state elision trackers
    let lastProg: WebGLProgram | null = null
    let lastVao: WebGLVertexArrayObject | null = null
    let lastTex0: WebGLTexture | null | undefined = undefined
    let lastTex1: WebGLTexture | null | undefined = undefined
    let lastActiveTexUnit = -1
    let lastBlend = -1
    let lastCull: boolean | null = null
    let lastFrontFace = -1

    const resetPassTracking = (): void => {
      lastProg = null
      lastVao = null
      lastTex0 = undefined
      lastTex1 = undefined
      lastActiveTexUnit = -1
      lastBlend = -1
      lastCull = null
      lastFrontFace = -1
    }

    const origDrawMesh = (this as unknown as { drawMesh: (...args: unknown[]) => void }).drawMesh
    // Temporarily override drawMesh during this doDrawModel() so setupClippingContext() mask draws
    // also benefit from shared VBO/VAO + state elision, then restore immediately in finally.
    let activeDrawableIndex = -1
    const drawSlot = (
      drawableIndex: number,
      textureNo: number,
      multiplyColor: { R: number; G: number; B: number; A: number },
      screenColor: { R: number; G: number; B: number; A: number },
      opacity: number,
      colorBlendMode: number,
      invertedMask: boolean
    ): void => {
      const slot = batch!.slots[drawableIndex]
      if (!slot || slot.iCount <= 0) return

      const culling = Boolean(this.isCulling())
      if (lastCull !== culling) {
        if (culling) gl.enable(gl.CULL_FACE)
        else gl.disable(gl.CULL_FACE)
        lastCull = culling
      }

      const mvpArray = this.getMvpMatrix().getArray()
      if (culling) {
        const det = mvpArray[0] * mvpArray[5] - mvpArray[1] * mvpArray[4]
        const ff = det < 0 ? gl.CW : gl.CCW
        if (lastFrontFace !== ff) {
          gl.frontFace(ff)
          lastFrontFace = ff
        }
      } else if (lastFrontFace !== gl.CCW) {
        gl.frontFace(gl.CCW)
        lastFrontFace = gl.CCW
      }

      const modelColor = this.getModelColor()
      let baseR = modelColor.R
      let baseG = modelColor.G
      let baseB = modelColor.B
      let baseA = modelColor.A
      const clipMaskBuf = this.getClippingContextBufferForMask()
      const premul = this.isPremultipliedAlpha()
      if (clipMaskBuf == null) {
        baseA *= opacity
        if (premul) {
          baseR *= baseA
          baseG *= baseA
          baseB *= baseA
        }
      }

      const drawTexture = this._textures[textureNo] ?? null
      let shaderSet: ShaderSetLike
      let blendKey = 0

      if (clipMaskBuf != null) {
        shaderSet = shaderSets[0]
        blendKey = 0
      } else {
        const clipDrawBuf = this.getClippingContextBufferForDraw()
        const masked = clipDrawBuf != null
        const offset = masked ? (invertedMask ? 2 : 1) : 0
        if (colorBlendMode === 1) {
          shaderSet = shaderSets[4 + offset]
          blendKey = 2
        } else if (colorBlendMode === 2) {
          shaderSet = shaderSets[7 + offset]
          blendKey = 3
        } else {
          shaderSet = shaderSets[1 + offset]
          blendKey = 1
        }
      }

      const prog = shaderSet.shaderProgram
      const pCache = getProgramCache(prog)
      if (lastProg !== prog) {
        gl.useProgram(prog)
        lastProg = prog
      }

      const vao = getOrCreateVao(batch!, shaderSet)
      if (lastVao !== vao) {
        gl.bindVertexArray(vao)
        lastVao = vao
      }

      if (!pCache.samplersInit) {
        gl.uniform1i(shaderSet.samplerTexture0Location, 0)
        if (shaderSet.samplerTexture1Location != null) {
          gl.uniform1i(shaderSet.samplerTexture1Location, 1)
        }
        pCache.samplersInit = true
      }

      if (lastTex0 !== drawTexture) {
        if (lastActiveTexUnit !== 0) {
          gl.activeTexture(gl.TEXTURE0)
          lastActiveTexUnit = 0
        }
        gl.bindTexture(gl.TEXTURE_2D, drawTexture)
        lastTex0 = drawTexture
      }

      if (clipMaskBuf != null) {
        const channelNo = clipMaskBuf._layoutChannelNo
        const colorChannel = clipMaskBuf.getClippingManager().getChannelFlagAsColor(channelNo)
        if (
          pCache.lastChanR !== colorChannel.R ||
          pCache.lastChanG !== colorChannel.G ||
          pCache.lastChanB !== colorChannel.B ||
          pCache.lastChanA !== colorChannel.A
        ) {
          gl.uniform4f(
            shaderSet.uniformChannelFlagLocation!,
            colorChannel.R,
            colorChannel.G,
            colorChannel.B,
            colorChannel.A
          )
          pCache.lastChanR = colorChannel.R
          pCache.lastChanG = colorChannel.G
          pCache.lastChanB = colorChannel.B
          pCache.lastChanA = colorChannel.A
        }
        const clipArr = clipMaskBuf._matrixForMask.getArray()
        if (!sameMatrix16(pCache.lastClipMatrix, clipArr)) {
          gl.uniformMatrix4fv(shaderSet.uniformClipMatrixLocation!, false, clipArr)
          if (!pCache.lastClipMatrix) pCache.lastClipMatrix = new Float32Array(16)
          pCache.lastClipMatrix.set(clipArr)
        }
        const rect = clipMaskBuf._layoutBounds
        const bR = rect.x * 2 - 1
        const bG = rect.y * 2 - 1
        const bB = rect.getRight() * 2 - 1
        const bA = rect.getBottom() * 2 - 1
        if (
          pCache.lastBaseR !== bR ||
          pCache.lastBaseG !== bG ||
          pCache.lastBaseB !== bB ||
          pCache.lastBaseA !== bA
        ) {
          gl.uniform4f(shaderSet.uniformBaseColorLocation, bR, bG, bB, bA)
          pCache.lastBaseR = bR
          pCache.lastBaseG = bG
          pCache.lastBaseB = bB
          pCache.lastBaseA = bA
        }
      } else {
        const clipDrawBuf = this.getClippingContextBufferForDraw()
        if (clipDrawBuf != null) {
          const maskTex = clipDrawBuf.getClippingManager().getColorBuffer()[clipDrawBuf._bufferIndex]
          if (lastTex1 !== maskTex) {
            if (lastActiveTexUnit !== 1) {
              gl.activeTexture(gl.TEXTURE1)
              lastActiveTexUnit = 1
            }
            gl.bindTexture(gl.TEXTURE_2D, maskTex)
            lastTex1 = maskTex
          }
          const clipArr = clipDrawBuf._matrixForDraw.getArray()
          if (!sameMatrix16(pCache.lastClipMatrix, clipArr)) {
            gl.uniformMatrix4fv(shaderSet.uniformClipMatrixLocation!, false, clipArr)
            if (!pCache.lastClipMatrix) pCache.lastClipMatrix = new Float32Array(16)
            pCache.lastClipMatrix.set(clipArr)
          }
          const colorChannel = clipDrawBuf
            .getClippingManager()
            .getChannelFlagAsColor(clipDrawBuf._layoutChannelNo)
          if (
            pCache.lastChanR !== colorChannel.R ||
            pCache.lastChanG !== colorChannel.G ||
            pCache.lastChanB !== colorChannel.B ||
            pCache.lastChanA !== colorChannel.A
          ) {
            gl.uniform4f(
              shaderSet.uniformChannelFlagLocation!,
              colorChannel.R,
              colorChannel.G,
              colorChannel.B,
              colorChannel.A
            )
            pCache.lastChanR = colorChannel.R
            pCache.lastChanG = colorChannel.G
            pCache.lastChanB = colorChannel.B
            pCache.lastChanA = colorChannel.A
          }
        }
        if (pCache.lastMatrixFrame !== currentFrameId) {
          gl.uniformMatrix4fv(shaderSet.uniformMatrixLocation!, false, mvpArray)
          pCache.lastMatrixFrame = currentFrameId
        }
        if (
          pCache.lastBaseR !== baseR ||
          pCache.lastBaseG !== baseG ||
          pCache.lastBaseB !== baseB ||
          pCache.lastBaseA !== baseA
        ) {
          gl.uniform4f(shaderSet.uniformBaseColorLocation, baseR, baseG, baseB, baseA)
          pCache.lastBaseR = baseR
          pCache.lastBaseG = baseG
          pCache.lastBaseB = baseB
          pCache.lastBaseA = baseA
        }
      }

      if (
        pCache.lastMulR !== multiplyColor.R ||
        pCache.lastMulG !== multiplyColor.G ||
        pCache.lastMulB !== multiplyColor.B ||
        pCache.lastMulA !== multiplyColor.A
      ) {
        gl.uniform4f(
          shaderSet.uniformMultiplyColorLocation,
          multiplyColor.R,
          multiplyColor.G,
          multiplyColor.B,
          multiplyColor.A
        )
        pCache.lastMulR = multiplyColor.R
        pCache.lastMulG = multiplyColor.G
        pCache.lastMulB = multiplyColor.B
        pCache.lastMulA = multiplyColor.A
      }

      if (
        pCache.lastScrR !== screenColor.R ||
        pCache.lastScrG !== screenColor.G ||
        pCache.lastScrB !== screenColor.B ||
        pCache.lastScrA !== screenColor.A
      ) {
        gl.uniform4f(
          shaderSet.uniformScreenColorLocation,
          screenColor.R,
          screenColor.G,
          screenColor.B,
          screenColor.A
        )
        pCache.lastScrR = screenColor.R
        pCache.lastScrG = screenColor.G
        pCache.lastScrB = screenColor.B
        pCache.lastScrA = screenColor.A
      }

      if (lastBlend !== blendKey) {
        if (blendKey === 0) {
          gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA)
        } else if (blendKey === 2) {
          gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE)
        } else if (blendKey === 3) {
          gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE)
        } else {
          gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        }
        lastBlend = blendKey
      }

      gl.drawElements(gl.TRIANGLES, slot.iCount, batch!.indexType, slot.iFirst * batch!.indexSize)
      this.setClippingContextBufferForDraw(null)
      this.setClippingContextBufferForMask(null)
    }

    ;(this as unknown as { drawMesh: (...args: unknown[]) => void }).drawMesh = (
      textureNo: unknown,
      _indexCount: unknown,
      _vertexCount: unknown,
      _indexArray: unknown,
      _vertexArray: unknown,
      _uvArray: unknown,
      multiplyColor: unknown,
      screenColor: unknown,
      opacity: unknown,
      colorBlendMode: unknown,
      invertedMask: unknown
    ): void => {
      if (activeDrawableIndex >= 0) {
        drawSlot(
          activeDrawableIndex,
          textureNo as number,
          multiplyColor as { R: number; G: number; B: number; A: number },
          screenColor as { R: number; G: number; B: number; A: number },
          opacity as number,
          colorBlendMode as number,
          Boolean(invertedMask)
        )
      } else {
        origDrawMesh.call(
          this,
          textureNo,
          _indexCount,
          _vertexCount,
          _indexArray,
          _vertexArray,
          _uvArray,
          multiplyColor,
          screenColor,
          opacity,
          colorBlendMode,
          invertedMask
        )
      }
    }

    try {
      if (this._clippingManager != null) {
        this.preDraw()
        // Intercept setupClippingContext's drawable index via getDrawableTextureIndex or wrap clipping?
        // Actually setupClippingContext calls model.getDrawableOpacity(clipDrawIndex) right before drawMesh!
        const origGetOpacity = model.getDrawableOpacity.bind(model)
        model.getDrawableOpacity = (idx: number): number => {
          activeDrawableIndex = idx
          return origGetOpacity(idx)
        }
        try {
          this._clippingManager.setupClippingContext(model, this)
        } finally {
          model.getDrawableOpacity = origGetOpacity
          activeDrawableIndex = -1
        }
        resetPassTracking()
      }

      this.preDraw()
      const drawableCount = model.getDrawableCount()
      const renderOrder = model.getDrawableRenderOrders()
      for (let i = 0; i < drawableCount; ++i) {
        this._sortedDrawableIndexList[renderOrder[i]] = i
      }

      for (let i = 0; i < drawableCount; ++i) {
        const drawableIndex = this._sortedDrawableIndexList[i]
        if (!model.getDrawableDynamicFlagIsVisible(drawableIndex)) {
          continue
        }
        const clipContext =
          this._clippingManager != null
            ? this._clippingManager.getClippingContextListForDraw()[drawableIndex]
            : null
        this.setClippingContextBufferForDraw(clipContext)
        this.setIsCulling(model.getDrawableCulling(drawableIndex))
        drawSlot(
          drawableIndex,
          model.getDrawableTextureIndex(drawableIndex),
          model.getMultiplyColor(drawableIndex),
          model.getScreenColor(drawableIndex),
          model.getDrawableOpacity(drawableIndex),
          model.getDrawableBlendMode(drawableIndex),
          model.getDrawableInvertedMaskBit(drawableIndex)
        )
      }
    } finally {
      ;(this as unknown as { drawMesh: (...args: unknown[]) => void }).drawMesh = origDrawMesh
      gl.bindVertexArray(null)
      gl.useProgram(null)
      gl.activeTexture(gl.TEXTURE0)
    }
  }

  rendererProtoPatched = true
  return true
}

/**
 * Installs WebGL2 shared-VBO/static-UV/static-IBO, cached-VAO, and redundant GL-state
 * elision optimizations onto `CubismRenderer_WebGL` (inspired by `ournotes-player/src/live2d/drawing.js`).
 * Hooks `Cubism4InternalModel.prototype.updateWebGLContext` so the first live renderer
 * instance installs the prototype patch without depending on unexported library classes.
 */
export function installCubismWebGL2Optimizer(): boolean {
  if (installed) return true
  const internalProto = Cubism4InternalModel?.prototype as
    | (Cubism4InternalModel & {
        updateWebGLContext: (gl: WebGLRenderingContext, glContextID: number) => void
      })
    | undefined
  if (!internalProto || typeof internalProto.updateWebGLContext !== 'function') {
    return false
  }
  const origUpdateWebGLContext = internalProto.updateWebGLContext
  internalProto.updateWebGLContext = function (
    this: Cubism4InternalModel,
    gl: WebGLRenderingContext,
    glContextID: number
  ): void {
    origUpdateWebGLContext.call(this, gl, glContextID)
    if (!rendererProtoPatched && this.renderer) {
      patchRendererPrototype(Object.getPrototypeOf(this.renderer) as Record<string, unknown>)
    }
  }
  installed = true
  return true
}
