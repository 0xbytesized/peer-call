/**
 * RNNoise noise suppression for PeerCall — AudioWorklet backend.
 *
 * Uses `@sapphi-red/web-noise-suppressor`, which ships an AudioWorkletProcessor
 * that runs RNNoise on the audio render thread (no more ScriptProcessor
 * deprecation warning, no main-thread audio glitches).
 *
 * Key design points:
 * - A CLONE of the original audio track is stored so the caller can restore
 *   it bitwise-identical when disabling NS.
 * - WASM bytes are fetched once and cached; the worklet module is installed
 *   once per AudioContext.
 * - `updateSource()` lets callers rebuild the pipeline on a new mic without
 *   leaving a stale original-track clone behind.
 */

import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'

let wasmBinary: ArrayBuffer | null = null
let initPromise: Promise<void> | null = null
let isActive = false

// Audio processing nodes
let audioContext: AudioContext | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let rnnoiseNode: RnnoiseWorkletNode | null = null
let destinationNode: MediaStreamAudioDestinationNode | null = null

// Cloned original track, handed back when NS is disabled
let originalAudioTrack: MediaStreamTrack | null = null

export async function initNoiseSuppression(): Promise<void> {
  if (wasmBinary) return
  if (initPromise) {
    await initPromise
    return
  }
  initPromise = (async () => {
    try {
      wasmBinary = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    } catch (err) {
      console.error('[PeerCall] Failed to load RNNoise WASM:', err)
      wasmBinary = null
    }
  })()
  try {
    await initPromise
  } finally {
    initPromise = null
  }
}

function teardownGraph() {
  try {
    rnnoiseNode?.disconnect()
    sourceNode?.disconnect()
  } catch {
    // disconnect() can throw if already disconnected; ignore
  }
  try {
    rnnoiseNode?.destroy()
  } catch {
    // destroy() may race with context close
  }
  rnnoiseNode = null
  sourceNode = null
  destinationNode = null
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {})
  }
  audioContext = null
}

/**
 * Build the audio graph on top of `stream`'s audio track and return
 * a new MediaStream whose audio has been denoised.
 */
async function buildGraph(stream: MediaStream): Promise<MediaStream> {
  if (!wasmBinary) {
    throw new Error('RNNoise WASM not available')
  }

  audioContext = new AudioContext({ sampleRate: 48000 })
  await audioContext.audioWorklet.addModule(rnnoiseWorkletUrl)

  sourceNode = audioContext.createMediaStreamSource(stream)
  rnnoiseNode = new RnnoiseWorkletNode(audioContext, { maxChannels: 2, wasmBinary })
  destinationNode = audioContext.createMediaStreamDestination()

  sourceNode.connect(rnnoiseNode)
  rnnoiseNode.connect(destinationNode)

  return new MediaStream([destinationNode.stream.getAudioTracks()[0], ...stream.getVideoTracks()])
}

/**
 * Enable noise suppression on a MediaStream.
 * Returns a new MediaStream with the cleaned audio track.
 */
export async function enableNoiseSuppression(stream: MediaStream): Promise<MediaStream> {
  await initNoiseSuppression()
  if (!wasmBinary) {
    throw new Error('RNNoise WASM not available')
  }

  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) return stream

  if (isActive && destinationNode) {
    return new MediaStream([destinationNode.stream.getAudioTracks()[0], ...stream.getVideoTracks()])
  }

  // Clone the original so disable can hand it back later.
  const clone = audioTracks[0].clone()
  try {
    const processedStream = await buildGraph(stream)
    originalAudioTrack = clone
    isActive = true
    return processedStream
  } catch (err) {
    // Failed partway through — don't leak the clone or a half-built graph.
    clone.stop()
    teardownGraph()
    throw err
  }
}

/**
 * Rebuild the NS pipeline against a new source stream (e.g. after the user
 * switches microphone while NS is active). The previously cloned original
 * is stopped and replaced, and a freshly processed MediaStream is returned
 * for the caller to swap into localStream and the remote senders.
 *
 * Returns null if NS is not currently active.
 */
export async function updateNoiseSuppressionSource(stream: MediaStream): Promise<MediaStream | null> {
  if (!isActive) return null
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) return null

  // Release the stale clone from the previous mic.
  originalAudioTrack?.stop()
  originalAudioTrack = null

  teardownGraph()

  const clone = audioTracks[0].clone()
  try {
    const processedStream = await buildGraph(stream)
    originalAudioTrack = clone
    return processedStream
  } catch (err) {
    clone.stop()
    isActive = false
    console.error('[PeerCall] updateNoiseSuppressionSource failed:', err)
    return null
  }
}

/**
 * Disable noise suppression.
 * Returns the original (cloned) audio track, or null if not active.
 */
export function disableNoiseSuppression(): MediaStreamTrack | null {
  if (!isActive) {
    // If a previous enable failed partway, there might still be an orphan
    // clone lingering. Hand it back so the caller can stop it.
    const orphan = originalAudioTrack
    originalAudioTrack = null
    return orphan
  }

  teardownGraph()
  isActive = false

  const track = originalAudioTrack
  originalAudioTrack = null
  return track
}

/**
 * Check if noise suppression is currently active.
 */
export function isNoiseSuppressionActive(): boolean {
  return isActive
}

/**
 * Clean up all resources.
 */
export function cleanupNoiseSuppression(): void {
  const leftover = disableNoiseSuppression()
  leftover?.stop()
  wasmBinary = null
}
