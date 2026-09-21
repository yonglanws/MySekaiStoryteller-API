import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'

export interface WebGLValidationResult {
  success: boolean
  webglVersion: 'webgl' | 'webgl2' | null
  errors: string[]
  warnings: string[]
  shaderInfo: {
    vertexCompiled: boolean
    fragmentCompiled: boolean
    programLinked: boolean
    vertexLog?: string
    fragmentLog?: string
    programLog?: string
  }
  contextInfo: {
    renderer?: string
    vendor?: string
    version?: string
    shadingLanguageVersion?: string
    maxTextureSize?: number
    isContextLost: boolean
  }
}

export class WebGLContextValidator {
  private logger: Logger<ILogObj> = getSubLogger('WebGLContextValidator')

  public async validateCanvas(canvas: HTMLCanvasElement): Promise<WebGLValidationResult> {
    const result: WebGLValidationResult = {
      success: false,
      webglVersion: null,
      errors: [],
      warnings: [],
      shaderInfo: {
        vertexCompiled: false,
        fragmentCompiled: false,
        programLinked: false
      },
      contextInfo: {
        isContextLost: true
      }
    }

    const gl = this.initializeWebGL(canvas, result)
    if (!gl) {
      this.logResult(result)
      return result
    }

    this.checkContextStatus(gl, result)
    this.getGPUInfo(gl, result)
    this.testShaderCompilation(gl, result)
    this.testBasicRenderPipeline(result)

    result.success =
      result.errors.length === 0 &&
      result.shaderInfo.vertexCompiled &&
      result.shaderInfo.fragmentCompiled &&
      result.shaderInfo.programLinked &&
      !result.contextInfo.isContextLost

    this.logResult(result)
    return result
  }

  private initializeWebGL(
    canvas: HTMLCanvasElement,
    result: WebGLValidationResult
  ): WebGL2RenderingContext | WebGLRenderingContext | null {
    let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null

    try {
      gl = canvas.getContext('webgl2', {
        preserveDrawingBuffer: true,
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      })
    } catch (e) {
      result.warnings.push(
        'WebGL2 context creation failed: ' + (e instanceof Error ? e.message : String(e))
      )
    }

    if (gl) {
      result.webglVersion = 'webgl2'
      this.logger.info('WebGL2 context created successfully')
      return gl
    }

    try {
      gl = canvas.getContext('webgl', {
        preserveDrawingBuffer: true,
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      })
    } catch (e) {
      result.warnings.push(
        'WebGL context creation failed: ' + (e instanceof Error ? e.message : String(e))
      )
    }

    if (gl) {
      result.webglVersion = 'webgl'
      this.logger.info('WebGL context created successfully (fallback from WebGL2)')
      return gl
    }

    result.errors.push('Failed to create WebGL context. No WebGL support available.')
    return null
  }

  private checkContextStatus(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    result: WebGLValidationResult
  ): void {
    if (gl.isContextLost()) {
      result.errors.push('WebGL context is already lost after creation')
      result.contextInfo.isContextLost = true
      return
    }

    result.contextInfo.isContextLost = false

    const loseContextExt = gl.getExtension('WEBGL_lose_context')
    if (!loseContextExt) {
      result.warnings.push('WEBGL_lose_context extension not available')
    }
  }

  private getGPUInfo(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    result: WebGLValidationResult
  ): void {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')

    if (debugInfo) {
      result.contextInfo.renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      result.contextInfo.vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
    } else {
      result.contextInfo.renderer = gl.getParameter(gl.RENDERER)
      result.contextInfo.vendor = gl.getParameter(gl.VENDOR)
      result.warnings.push('WEBGL_debug_renderer_info not available')
    }

    result.contextInfo.version = gl.getParameter(gl.VERSION)
    result.contextInfo.shadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION)
    result.contextInfo.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)

    this.logger.info('GPU Info:', {
      renderer: result.contextInfo.renderer,
      vendor: result.contextInfo.vendor,
      version: result.contextInfo.version,
      glsl: result.contextInfo.shadingLanguageVersion,
      maxTexture: result.contextInfo.maxTextureSize
    })
  }

  private testShaderCompilation(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    result: WebGLValidationResult
  ): void {
    const vertexShaderSource = this.getBasicVertexShader(gl)
    const fragmentShaderSource = this.getBasicFragmentShader(gl)

    const vertexShader = gl.createShader(gl.VERTEX_SHADER)
    if (!vertexShader) {
      result.errors.push('Failed to create vertex shader object')
      return
    }

    gl.shaderSource(vertexShader, vertexShaderSource)
    gl.compileShader(vertexShader)

    const vertexCompiled = gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)
    result.shaderInfo.vertexCompiled = !!vertexCompiled

    if (!vertexCompiled) {
      const log = gl.getShaderInfoLog(vertexShader) || 'Unknown error'
      result.shaderInfo.vertexLog = log
      result.errors.push(`Vertex shader compilation failed: ${log}`)
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)
    if (!fragmentShader) {
      result.errors.push('Failed to create fragment shader object')
      return
    }

    gl.shaderSource(fragmentShader, fragmentShaderSource)
    gl.compileShader(fragmentShader)

    const fragmentCompiled = gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)
    result.shaderInfo.fragmentCompiled = !!fragmentCompiled

    if (!fragmentCompiled) {
      const log = gl.getShaderInfoLog(fragmentShader) || 'Unknown error'
      result.shaderInfo.fragmentLog = log
      result.errors.push(`Fragment shader compilation failed: ${log}`)
    }

    if (!result.shaderInfo.vertexCompiled || !result.shaderInfo.fragmentCompiled) {
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      return
    }

    const program = gl.createProgram()
    if (!program) {
      result.errors.push('Failed to create shader program')
      return
    }

    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)

    const programLinked = gl.getProgramParameter(program, gl.LINK_STATUS)
    result.shaderInfo.programLinked = !!programLinked

    if (!programLinked) {
      const log = gl.getProgramInfoLog(program) || 'Unknown error'
      result.shaderInfo.programLog = log
      result.errors.push(`Shader program linking failed: ${log}`)
    }

    const activeAttribs = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES)
    this.logger.info(`Shader program: ${activeAttribs} active attributes`)

    if (programLinked) {
      try {
        const positionAttrib = gl.getAttribLocation(program, 'a_position')
        if (positionAttrib === -1) {
          result.warnings.push('a_position attribute not found in shader program')
        }
      } catch (e) {
        result.errors.push(
          `Failed to get attribute location: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }

    gl.deleteProgram(program)
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
  }

  /**
   * 基础渲染管线测试（clear + readPixels）。
   * 在一次性离屏画布上执行：此前直接清空共享的活动画布，既可能把红色
   * 带进录制首帧，也会让「模型不渲染时画布残留红色」通过黑屏亮度校验。
   */
  private testBasicRenderPipeline(result: WebGLValidationResult): void {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) {
      result.warnings.push('Offscreen GL context creation failed for render pipeline test')
      return
    }

    try {
      gl.clearColor(1, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)

      const pixel = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)

      if (pixel[0] !== 255 || pixel[1] !== 0 || pixel[2] !== 0) {
        result.warnings.push(
          `Render test failed: expected red (255,0,0) but got (${pixel[0]},${pixel[1]},${pixel[2]})`
        )
      } else {
        this.logger.info('Basic render pipeline test passed')
      }
    } catch (e) {
      result.errors.push(
        `Render pipeline test failed: ${e instanceof Error ? e.message : String(e)}`
      )
    } finally {
      const loseExt = gl.getExtension('WEBGL_lose_context')
      loseExt?.loseContext()
    }
  }

  private getBasicVertexShader(gl: WebGL2RenderingContext | WebGLRenderingContext): string {
    if (gl instanceof WebGL2RenderingContext) {
      return `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0, 1);
}`
    }
    return `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0, 1);
}`
  }

  private getBasicFragmentShader(gl: WebGL2RenderingContext | WebGLRenderingContext): string {
    if (gl instanceof WebGL2RenderingContext) {
      return `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0, 0.0, 0.0, 1.0);
}`
    }
    return `precision mediump float;
void main() {
  gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
}`
  }

  public async validateFrameCapture(canvas: HTMLCanvasElement): Promise<boolean> {
    try {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.5)
      })

      if (!blob) {
        this.logger.error('Frame capture test failed: canvas.toBlob returned null')
        return false
      }

      if (blob.size === 0) {
        this.logger.error('Frame capture test failed: blob size is 0')
        return false
      }

      this.logger.info(`Frame capture test passed: blob size = ${(blob.size / 1024).toFixed(1)} KB`)
      return true
    } catch (e) {
      this.logger.error('Frame capture test failed:', e)
      return false
    }
  }

  public async validateModelRendering(
    canvas: HTMLCanvasElement,
    timeoutMs: number = 5000
  ): Promise<{ success: boolean; averageBrightness: number }> {
    const startTime = performance.now()
    const samples: number[] = []
    const sampleCount = 5

    for (let i = 0; i < sampleCount; i++) {
      if (performance.now() - startTime > timeoutMs) {
        this.logger.warn('Model validation timeout')
        break
      }

      await new Promise((resolve) => setTimeout(resolve, 200))

      try {
        const brightness = await this.measureFrameBrightness(canvas)
        samples.push(brightness)
        this.logger.debug(`Frame brightness sample ${i + 1}: ${brightness.toFixed(2)}%`)
      } catch (e) {
        this.logger.warn('Failed to measure frame brightness:', e)
      }
    }

    if (samples.length === 0) {
      return { success: false, averageBrightness: 0 }
    }

    const averageBrightness = samples.reduce((a, b) => a + b, 0) / samples.length

    const isBlackScreen = averageBrightness < 2
    if (isBlackScreen) {
      this.logger.error(
        `Model rendering validation failed: average brightness ${averageBrightness.toFixed(2)}% is too low (black screen detected)`
      )
    } else {
      this.logger.info(
        `Model rendering validation passed: average brightness ${averageBrightness.toFixed(2)}%`
      )
    }

    return { success: !isBlackScreen, averageBrightness }
  }

  private async measureFrameBrightness(canvas: HTMLCanvasElement): Promise<number> {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl || gl.isContextLost()) {
      throw new Error('WebGL context not available')
    }

    const width = Math.min(canvas.width, 128)
    const height = Math.min(canvas.height, 128)
    const pixels = new Uint8Array(width * height * 4)

    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    let totalBrightness = 0
    let pixelCount = 0

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]
      const a = pixels[i + 3]

      if (a > 0) {
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114) / 255
        totalBrightness += brightness
        pixelCount++
      }
    }

    return pixelCount > 0 ? (totalBrightness / pixelCount) * 100 : 0
  }

  private logResult(result: WebGLValidationResult): void {
    if (result.success) {
      this.logger.info('WebGL validation PASSED', {
        version: result.webglVersion,
        gpu: result.contextInfo.renderer
      })
    } else {
      this.logger.error('WebGL validation FAILED', {
        errors: result.errors,
        warnings: result.warnings,
        shaderInfo: result.shaderInfo
      })
    }
  }
}

export const webGLValidator = new WebGLContextValidator()
