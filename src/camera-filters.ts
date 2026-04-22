/**
 * WebGL-based video filter pipeline for the outgoing camera stream.
 *
 * The raw camera track feeds a hidden <video> element. Each animation frame
 * the video is uploaded as a texture, processed by a pair of fragment
 * shaders (horizontal blur, then vertical blur + color adjustments), and
 * the resulting canvas is captured via `canvas.captureStream()`. That
 * derived track goes into localStream and the WebRTC senders, so remote
 * peers see the filtered image.
 *
 * Why WebGL over the 2D canvas `ctx.filter` approach: Safari (< 18)
 * silently ignores `ctx.filter`, so filters didn't retransmit on iPad.
 * WebGL runs the same shader everywhere — Safari, Chrome, Firefox, mobile.
 */

export interface CameraFilters {
  brightness: number
  contrast: number
  saturation: number
  blur: number
}

export const DEFAULT_FILTERS: CameraFilters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  blur: 0,
}

const FILTER_KEY = 'peercall-filters'

export function loadFilters(): CameraFilters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}')
    return { ...DEFAULT_FILTERS, ...saved }
  } catch {
    return { ...DEFAULT_FILTERS }
  }
}

export function saveFilters(f: CameraFilters): void {
  localStorage.setItem(FILTER_KEY, JSON.stringify(f))
}

/** CSS filter string, used as a local-preview fallback when WebGL is unavailable. */
export function filtersToCss(f: CameraFilters): string {
  const parts: string[] = []
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`)
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`)
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`)
  if (f.blur > 0) parts.push(`blur(${f.blur}px)`)
  return parts.length ? parts.join(' ') : 'none'
}

/** True if we can create a WebGL context; used to decide whether to run the pipeline. */
export function detectPipelineSupport(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    return gl !== null
  } catch {
    return false
  }
}

export interface CameraPipeline {
  readonly input: MediaStreamTrack
  readonly output: MediaStreamTrack
  setFilters(f: CameraFilters): void
  stop(): void
}

// ─── Shaders ───

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

// Horizontal blur pass — 9-tap gaussian (sigma=2), weights sum to ~1.
// `uDirection` lets us reuse the same shader for vertical if ever needed,
// but here we use this only for horizontal.
const BLUR_FRAG_SRC = `
precision mediump float;
uniform sampler2D uTexture;
uniform float uBlur;
uniform vec2 uTexSize;
uniform vec2 uDirection;
varying vec2 vUV;

const float W0 = 0.0540;
const float W1 = 0.0882;
const float W2 = 0.1292;
const float W3 = 0.1695;
const float W4 = 0.1994;

void main() {
  vec2 step = uDirection / uTexSize * uBlur * 0.25;
  vec3 color = texture2D(uTexture, vUV + step * -4.0).rgb * W0
             + texture2D(uTexture, vUV + step * -3.0).rgb * W1
             + texture2D(uTexture, vUV + step * -2.0).rgb * W2
             + texture2D(uTexture, vUV + step * -1.0).rgb * W3
             + texture2D(uTexture, vUV              ).rgb * W4
             + texture2D(uTexture, vUV + step *  1.0).rgb * W3
             + texture2D(uTexture, vUV + step *  2.0).rgb * W2
             + texture2D(uTexture, vUV + step *  3.0).rgb * W1
             + texture2D(uTexture, vUV + step *  4.0).rgb * W0;
  gl_FragColor = vec4(color, 1.0);
}
`

// Vertical blur (when uBlur > 0) + brightness/contrast/saturation.
// When uBlur == 0, `step` is zero-vector, all 9 samples are the same pixel,
// weights sum to 1, output = input (no-op blur).
const COMPOSITE_FRAG_SRC = `
precision mediump float;
uniform sampler2D uTexture;
uniform float uBlur;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform vec2 uTexSize;
uniform vec2 uDirection;
varying vec2 vUV;

const float W0 = 0.0540;
const float W1 = 0.0882;
const float W2 = 0.1292;
const float W3 = 0.1695;
const float W4 = 0.1994;

void main() {
  vec2 step = uDirection / uTexSize * uBlur * 0.25;
  vec3 color = texture2D(uTexture, vUV + step * -4.0).rgb * W0
             + texture2D(uTexture, vUV + step * -3.0).rgb * W1
             + texture2D(uTexture, vUV + step * -2.0).rgb * W2
             + texture2D(uTexture, vUV + step * -1.0).rgb * W3
             + texture2D(uTexture, vUV              ).rgb * W4
             + texture2D(uTexture, vUV + step *  1.0).rgb * W3
             + texture2D(uTexture, vUV + step *  2.0).rgb * W2
             + texture2D(uTexture, vUV + step *  3.0).rgb * W1
             + texture2D(uTexture, vUV + step *  4.0).rgb * W0;

  color *= uBrightness;
  color = (color - 0.5) * uContrast + 0.5;
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(luma), color, uSaturation);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('createShader failed')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return shader
}

function createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('createProgram failed')
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`Program link failed: ${log}`)
  }
  return program
}

/**
 * Start a filter pipeline. The pipeline takes ownership of `cameraTrack`
 * and will stop it when `stop()` is called.
 */
export function startCameraPipeline(cameraTrack: MediaStreamTrack, initialFilters: CameraFilters): CameraPipeline {
  const video = document.createElement('video')
  video.srcObject = new MediaStream([cameraTrack])
  video.playsInline = true
  video.muted = true
  video.play().catch((err) => {
    console.error('[PeerCall] Pipeline video play() failed:', err)
  })

  const canvas = document.createElement('canvas')
  const settings = cameraTrack.getSettings()
  canvas.width = settings.width ?? 1280
  canvas.height = settings.height ?? 720

  // `preserveDrawingBuffer: true` is important: without it, captureStream
  // can sometimes sample the cleared buffer between our render and the
  // compositor, producing black frames.
  const gl =
    canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false }) ||
    (canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true }) as WebGLRenderingContext | null)
  if (!gl) throw new Error('WebGL not available')

  const programBlur = createProgram(gl, VERT_SRC, BLUR_FRAG_SRC)
  const programComposite = createProgram(gl, VERT_SRC, COMPOSITE_FRAG_SRC)

  // Fullscreen quad as two triangles
  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)

  // Flip Y on upload: video frames are top-down, WebGL textures are bottom-up
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

  const videoTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, videoTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  // FBO and attached texture for the horizontal blur pass
  const fbo = gl.createFramebuffer()
  const fboTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, fboTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  function resizeFbo(w: number, h: number) {
    gl!.bindTexture(gl!.TEXTURE_2D, fboTex)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, w, h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo)
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, fboTex, 0)
  }
  resizeFbo(canvas.width, canvas.height)

  function bindQuad(program: WebGLProgram) {
    gl!.useProgram(program)
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quad)
    const loc = gl!.getAttribLocation(program, 'aPos')
    gl!.enableVertexAttribArray(loc)
    gl!.vertexAttribPointer(loc, 2, gl!.FLOAT, false, 0, 0)
  }

  let currentFilters = initialFilters
  let running = true
  let rafId = 0
  let lastW = 0
  let lastH = 0

  const render = () => {
    if (!running) return
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const w = video.videoWidth
      const h = video.videoHeight
      if (w !== lastW || h !== lastH) {
        canvas.width = w
        canvas.height = h
        resizeFbo(w, h)
        lastW = w
        lastH = h
      }

      // Upload latest video frame
      gl.bindTexture(gl.TEXTURE_2D, videoTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)

      gl.viewport(0, 0, w, h)

      let sourceTex: WebGLTexture = videoTex!

      if (currentFilters.blur > 0) {
        // Pass 1: horizontal blur, video → FBO
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        bindQuad(programBlur)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, videoTex)
        gl.uniform1i(gl.getUniformLocation(programBlur, 'uTexture'), 0)
        gl.uniform1f(gl.getUniformLocation(programBlur, 'uBlur'), currentFilters.blur)
        gl.uniform2f(gl.getUniformLocation(programBlur, 'uDirection'), 1, 0)
        gl.uniform2f(gl.getUniformLocation(programBlur, 'uTexSize'), w, h)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        sourceTex = fboTex!
      }

      // Pass 2: vertical blur (if blur > 0, else no-op) + color, → canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      bindQuad(programComposite)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, sourceTex)
      gl.uniform1i(gl.getUniformLocation(programComposite, 'uTexture'), 0)
      gl.uniform1f(gl.getUniformLocation(programComposite, 'uBlur'), currentFilters.blur)
      gl.uniform1f(gl.getUniformLocation(programComposite, 'uBrightness'), currentFilters.brightness)
      gl.uniform1f(gl.getUniformLocation(programComposite, 'uContrast'), currentFilters.contrast)
      gl.uniform1f(gl.getUniformLocation(programComposite, 'uSaturation'), currentFilters.saturation)
      gl.uniform2f(gl.getUniformLocation(programComposite, 'uDirection'), 0, 1)
      gl.uniform2f(gl.getUniformLocation(programComposite, 'uTexSize'), w, h)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    rafId = requestAnimationFrame(render)
  }
  rafId = requestAnimationFrame(render)

  const outStream = canvas.captureStream(30)
  const outTrack = outStream.getVideoTracks()[0]

  return {
    input: cameraTrack,
    output: outTrack,
    setFilters(f) {
      currentFilters = f
    },
    stop() {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
      cameraTrack.stop()
      outStream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
      gl.deleteProgram(programBlur)
      gl.deleteProgram(programComposite)
      if (quad) gl.deleteBuffer(quad)
      if (videoTex) gl.deleteTexture(videoTex)
      if (fboTex) gl.deleteTexture(fboTex)
      if (fbo) gl.deleteFramebuffer(fbo)
    },
  }
}
