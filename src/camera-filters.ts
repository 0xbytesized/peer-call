/**
 * Canvas-based video filter pipeline for the outgoing camera stream.
 *
 * The raw camera track feeds a hidden <video> element. Each animation
 * frame that element is drawn onto a <canvas> with `ctx.filter` applied,
 * and `canvas.captureStream()` gives us a new MediaStreamTrack whose
 * content is the filtered video. That track is what goes into localStream
 * and the WebRTC senders, so remote peers see the filtered image.
 *
 * When all filters are at their defaults the canvas still runs (simpler
 * than conditionally swapping pipelines). Cost on desktop is negligible;
 * on low-end mobile it's noticeable but acceptable.
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

export function filtersAreDefault(f: CameraFilters): boolean {
  return (
    f.brightness === DEFAULT_FILTERS.brightness &&
    f.contrast === DEFAULT_FILTERS.contrast &&
    f.saturation === DEFAULT_FILTERS.saturation &&
    f.blur === DEFAULT_FILTERS.blur
  )
}

function buildCssFilter(f: CameraFilters): string {
  const parts: string[] = []
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`)
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`)
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`)
  if (f.blur > 0) parts.push(`blur(${f.blur}px)`)
  return parts.length ? parts.join(' ') : 'none'
}

export interface CameraPipeline {
  readonly input: MediaStreamTrack
  readonly output: MediaStreamTrack
  setFilters(f: CameraFilters): void
  stop(): void
}

/**
 * Start a filter pipeline. The caller owns `cameraTrack` until this
 * returns; after that the pipeline owns it and will stop it on `stop()`.
 */
export function startCameraPipeline(cameraTrack: MediaStreamTrack, initialFilters: CameraFilters): CameraPipeline {
  const video = document.createElement('video')
  video.srcObject = new MediaStream([cameraTrack])
  video.playsInline = true
  video.muted = true

  // `autoplay` alone is unreliable on detached <video> elements (not in DOM).
  // Explicit play() ensures frames start flowing so the canvas has something
  // to draw.
  video.play().catch((err) => {
    console.error('[PeerCall] Pipeline video play() failed:', err)
  })

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('2D canvas context not available')

  // Seed canvas dimensions so captureStream has something to latch onto
  // before the first frame arrives.
  const settings = cameraTrack.getSettings()
  canvas.width = settings.width ?? 640
  canvas.height = settings.height ?? 480

  let currentFilters = initialFilters
  let running = true
  let rafId = 0

  const render = () => {
    if (!running) return
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight
      ctx.filter = buildCssFilter(currentFilters)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
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
    },
  }
}
