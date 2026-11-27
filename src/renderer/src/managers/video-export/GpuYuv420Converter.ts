const nativeSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis)

const fastYield: () => Promise<void> = (() => {
  if (typeof MessageChannel !== 'undefined') {
    const ch = new MessageChannel()
    const waiters: Array<() => void> = []
    ch.port1.onmessage = () => {
      waiters.shift()?.()
    }
    return () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve)
        ch.port2.postMessage(null)
      })
  }
  return () => new Promise<void>((resolve) => nativeSetTimeout(resolve, 0))
})()

const VERTEX_SHADER_SRC = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uTex;
uniform int uWidth;
uniform int uHeight;

out vec4 fragColor;

vec3 sampleRgb(int px, int py) {
  vec2 uv = vec2((float(px) + 0.5) / float(uWidth), (float(py) + 0.5) / float(uHeight));
  return texture(uTex, uv).rgb;
}

vec3 sampleChromaAvg(int cx, int cy) {
  int x0 = cx * 2;
  int y0 = cy * 2;
  return 0.25 * (
    sampleRgb(x0, y0) +
    sampleRgb(x0 + 1, y0) +
    sampleRgb(x0, y0 + 1) +
    sampleRgb(x0 + 1, y0 + 1)
  );
}

float calcY(vec3 c) {
  return (16.0 + 219.0 * clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0)) / 255.0;
}

float calcU(vec3 c) {
  return (128.0 + 224.0 * clamp(dot(c, vec3(-0.11457210605734, -0.38542789394266, 0.5)), -0.5, 0.5)) / 255.0;
}

float calcV(vec3 c) {
  return (128.0 + 224.0 * clamp(dot(c, vec3(0.5, -0.45415290830582, -0.04584709169418)), -0.5, 0.5)) / 255.0;
}

float evalPlaneByte(int ix, int iy, int k) {
  int bIdx = ix * 4 + k;
  if (iy < uHeight) {
    return calcY(sampleRgb(bIdx, iy));
  }
  int uRows = uHeight / 4;
  int halfW = uWidth / 2;
  if (iy < uHeight + uRows) {
    int b = (iy - uHeight) * uWidth + bIdx;
    int uy = b / halfW;
    int ux = b - uy * halfW;
    return calcU(sampleChromaAvg(ux, uy));
  }
  int b = (iy - uHeight - uRows) * uWidth + bIdx;
  int vy = b / halfW;
  int vx = b - vy * halfW;
  return calcV(sampleChromaAvg(vx, vy));
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  fragColor = vec4(
    evalPlaneByte(fc.x, fc.y, 0),
    evalPlaneByte(fc.x, fc.y, 1),
    evalPlaneByte(fc.x, fc.y, 2),
    evalPlaneByte(fc.x, fc.y, 3)
  );
}
`

interface PboSlot {
  buffer: WebGLBuffer
  sync: WebGLSync | null
  inUse: boolean
}

function getSourceDimensions(source: TexImageSource): { width: number; height: number } | null {
  const s = source as {
    videoWidth?: number
    videoHeight?: number
    naturalWidth?: number
    naturalHeight?: number
    codedWidth?: number
    codedHeight?: number
    displayWidth?: number
    displayHeight?: number
    width?: number
    height?: number
  }
  const width = s.videoWidth ?? s.naturalWidth ?? s.codedWidth ?? s.displayWidth ?? s.width
  const height = s.videoHeight ?? s.naturalHeight ?? s.codedHeight ?? s.displayHeight ?? s.height
  if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
    return { width, height }
  }
  return null
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/**
 * Offscreen WebGL2 GPU pass that scales (via bilinear sampling) and packs any canvas
 * source directly into BT.709 limited-range `yuv420p` (`I420`, 1.5 bytes/pixel).
 */
export class GpuYuv420Converter {
  public readonly width: number
  public readonly height: number
  public readonly frameByteLength: number
  private readonly packW: number
  private readonly packH: number

  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly vbo: WebGLBuffer
  private readonly srcTexture: WebGLTexture
  private readonly fboTexture: WebGLTexture
  private readonly fbo: WebGLFramebuffer

  private readonly pboSlots: PboSlot[] = []
  private readonly syncOutputBuffer: Uint8Array
  private srcTexWidth = 0
  private srcTexHeight = 0
  private pboCursor = 0
  private pendingSlots: number[] = []
  private disposed = false

  static isSupportedDimensions(width: number, height: number): boolean {
    return width > 0 && height > 0 && width % 4 === 0 && height % 4 === 0
  }

  static create(width: number, height: number, pboRingSize = 2): GpuYuv420Converter | null {
    if (!GpuYuv420Converter.isSupportedDimensions(width, height)) return null
    try {
      const surface =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(1, 1)
          : typeof document !== 'undefined' && typeof document.createElement === 'function'
            ? Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
            : null
      if (!surface) return null
      const gl = surface.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      }) as WebGL2RenderingContext | null
      if (!gl || typeof gl.fenceSync !== 'function' || typeof gl.getBufferSubData !== 'function') {
        return null
      }

      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC)
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)
      if (!vs || !fs) {
        if (vs) gl.deleteShader(vs)
        if (fs) gl.deleteShader(fs)
        return null
      }
      const program = gl.createProgram()
      if (!program) {
        gl.deleteShader(vs)
        gl.deleteShader(fs)
        return null
      }
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program)
        return null
      }

      const vao = gl.createVertexArray()
      const vbo = gl.createBuffer()
      const srcTexture = gl.createTexture()
      const fboTexture = gl.createTexture()
      const fbo = gl.createFramebuffer()
      if (!vao || !vbo || !srcTexture || !fboTexture || !fbo) {
        if (vao) gl.deleteVertexArray(vao)
        if (vbo) gl.deleteBuffer(vbo)
        if (srcTexture) gl.deleteTexture(srcTexture)
        if (fboTexture) gl.deleteTexture(fboTexture)
        if (fbo) gl.deleteFramebuffer(fbo)
        gl.deleteProgram(program)
        return null
      }

      const packW = width / 4
      const packH = (height * 3) / 2
      const frameByteLength = packW * packH * 4

      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const posLoc = gl.getAttribLocation(program, 'aPos')
      gl.enableVertexAttribArray(posLoc)
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)
      gl.bindVertexArray(null)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, srcTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      gl.bindTexture(gl.TEXTURE_2D, fboTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, packW, packH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTexture, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteVertexArray(vao)
        gl.deleteBuffer(vbo)
        gl.deleteTexture(srcTexture)
        gl.deleteTexture(fboTexture)
        gl.deleteFramebuffer(fbo)
        gl.deleteProgram(program)
        return null
      }

      gl.useProgram(program)
      gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0)
      gl.uniform1i(gl.getUniformLocation(program, 'uWidth'), width)
      gl.uniform1i(gl.getUniformLocation(program, 'uHeight'), height)
      gl.useProgram(null)

      const pboSlots: PboSlot[] = []
      const ringCount = Math.max(0, pboRingSize)
      for (let i = 0; i < ringCount; i++) {
        const buffer = gl.createBuffer()
        if (!buffer) break
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
        gl.bufferData(gl.PIXEL_PACK_BUFFER, frameByteLength, gl.STREAM_READ)
        pboSlots.push({ buffer, sync: null, inUse: false })
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)

      return new GpuYuv420Converter(
        width,
        height,
        packW,
        packH,
        frameByteLength,
        gl,
        program,
        vao,
        vbo,
        srcTexture,
        fboTexture,
        fbo,
        pboSlots
      )
    } catch {
      return null
    }
  }

  private constructor(
    width: number,
    height: number,
    packW: number,
    packH: number,
    frameByteLength: number,
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    vao: WebGLVertexArrayObject,
    vbo: WebGLBuffer,
    srcTexture: WebGLTexture,
    fboTexture: WebGLTexture,
    fbo: WebGLFramebuffer,
    pboSlots: PboSlot[]
  ) {
    this.width = width
    this.height = height
    this.packW = packW
    this.packH = packH
    this.frameByteLength = frameByteLength
    this.gl = gl
    this.program = program
    this.vao = vao
    this.vbo = vbo
    this.srcTexture = srcTexture
    this.fboTexture = fboTexture
    this.fbo = fbo
    this.pboSlots = pboSlots
    this.syncOutputBuffer = new Uint8Array(frameByteLength)
  }

  private renderToFbo(source: TexImageSource): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.packW, this.packH)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    const dims = getSourceDimensions(source)
    if (
      dims &&
      dims.width === this.srcTexWidth &&
      dims.height === this.srcTexHeight &&
      typeof gl.texSubImage2D === 'function'
    ) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      this.srcTexWidth = dims ? dims.width : 0
      this.srcTexHeight = dims ? dims.height : 0
    }
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  /** Synchronously converts and returns a reusable BT.709 I420 byte buffer. */
  public convertSync(source: TexImageSource): Uint8Array {
    if (this.disposed) throw new Error('GpuYuv420Converter disposed')
    const gl = this.gl
    this.renderToFbo(source)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.readPixels(0, 0, this.packW, this.packH, gl.RGBA, gl.UNSIGNED_BYTE, this.syncOutputBuffer)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return this.syncOutputBuffer
  }

  private async waitSync(sync: WebGLSync): Promise<void> {
    const gl = this.gl
    for (let guard = 0; guard < 1000 && !this.disposed; guard++) {
      const res = gl.clientWaitSync(sync, 0, 0)
      if (res === gl.ALREADY_SIGNALED || res === gl.CONDITION_SATISFIED) {
        return
      }
      if (res === gl.WAIT_FAILED) {
        this.warnSyncIssue('clientWaitSync returned WAIT_FAILED; proceeding with PBO readback')
        return
      }
      if (guard < 2) {
        await fastYield()
      } else {
        await new Promise<void>((resolve) => nativeSetTimeout(resolve, 1))
      }
    }
    if (!this.disposed) {
      this.warnSyncIssue('waitSync timed out after 1000 yields; proceeding with PBO readback')
    }
  }

  private lastSyncWarnAtMs = -Infinity

  private warnSyncIssue(reason: string): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now - this.lastSyncWarnAtMs < 5000) return
    this.lastSyncWarnAtMs = now
    console.warn(`[GpuYuv420Converter] ${reason}`)
  }

  private async readSlot(slotIndex: number, target?: Uint8Array): Promise<Uint8Array> {
    const slot = this.pboSlots[slotIndex]
    if (!slot || !slot.inUse) {
      throw new Error('PBO slot is empty')
    }
    const gl = this.gl
    if (slot.sync) {
      await this.waitSync(slot.sync)
      gl.deleteSync(slot.sync)
      slot.sync = null
    }
    const out = target ?? new Uint8Array(this.frameByteLength)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out, 0, this.frameByteLength)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    slot.inUse = false
    return out
  }

  /**
   * Starts an asynchronous PBO readback for `source`; if the PBO ring is full,
   * completes and returns the oldest queued frame first.
   */
  public async enqueueAsync(
    source: TexImageSource,
    reuseBuffer?: Uint8Array
  ): Promise<Uint8Array | null> {
    if (this.disposed) return null
    if (this.pboSlots.length === 0) {
      const syncBytes = this.convertSync(source)
      if (reuseBuffer && reuseBuffer.byteLength === this.frameByteLength) {
        reuseBuffer.set(syncBytes)
        return reuseBuffer
      }
      return syncBytes.slice()
    }

    const slotIdx = this.pboCursor
    this.pboCursor = (this.pboCursor + 1) % this.pboSlots.length
    const slot = this.pboSlots[slotIdx]
    const gl = this.gl

    // Issue GPU YUV shader + PBO DMA + flush FIRST so frame N executes on GPU in parallel
    // while CPU harvests the oldest already-completed PBO slot (true GPU/CPU overlap).
    this.renderToFbo(source)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
    gl.readPixels(0, 0, this.packW, this.packH, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    slot.inUse = true
    gl.flush()
    this.pendingSlots.push(slotIdx)

    if (this.pendingSlots.length >= this.pboSlots.length) {
      const oldestSlot = this.pendingSlots.shift()!
      return await this.readSlot(oldestSlot, reuseBuffer)
    }

    return null
  }

  public async drainAllAsync(acquireBuffer?: () => Uint8Array): Promise<Uint8Array[]> {
    const out: Uint8Array[] = []
    while (this.pendingSlots.length > 0 && !this.disposed) {
      const slotIdx = this.pendingSlots.shift()!
      const buf = acquireBuffer ? acquireBuffer() : undefined
      out.push(await this.readSlot(slotIdx, buf))
    }
    return out
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    for (const slot of this.pboSlots) {
      if (slot.sync) gl.deleteSync(slot.sync)
      gl.deleteBuffer(slot.buffer)
    }
    this.pboSlots.length = 0
    this.pendingSlots.length = 0
    gl.deleteFramebuffer(this.fbo)
    gl.deleteTexture(this.fboTexture)
    gl.deleteTexture(this.srcTexture)
    gl.deleteBuffer(this.vbo)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.program)
  }
}
