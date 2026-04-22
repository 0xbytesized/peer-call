/**
 * RNNoise noise suppression for PeerCall
 *
 * Uses @shiguredo/rnnoise-wasm to process audio in the main thread.
 * Creates a processed MediaStream that replaces the original audio track.
 *
 * Key design points:
 * - A CLONE of the original audio track is stored so the caller can restore
 *   it bitwise-identical when disabling NS.
 * - Output uses a ring buffer primed with one silent frame. ScriptProcessor
 *   chunks (4096) and RNNoise frames (480) are not multiples, so without
 *   priming the output would underrun ~every 85 ms and produce clicks.
 * - `updateSource()` lets callers rebuild the pipeline on a new mic without
 *   leaving a stale original-track clone behind.
 */

import { Rnnoise } from '@shiguredo/rnnoise-wasm'

let rnnoiseInstance: Rnnoise | null = null
let denoiseState: ReturnType<Rnnoise['createDenoiseState']> | null = null
let initPromise: Promise<void> | null = null
let isActive = false

// Audio processing nodes
let audioContext: AudioContext | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let destinationNode: MediaStreamAudioDestinationNode | null = null
let processorNode: ScriptProcessorNode | null = null

// Cloned original track, handed back when NS is disabled
let originalAudioTrack: MediaStreamTrack | null = null

const BUFFER_SIZE = 4096

export async function initNoiseSuppression(): Promise<void> {
  if (rnnoiseInstance && denoiseState) return
  if (initPromise) {
    await initPromise
    return
  }
  initPromise = (async () => {
    try {
      rnnoiseInstance = await Rnnoise.load()
      denoiseState = rnnoiseInstance.createDenoiseState()
    } catch (err) {
      console.error('[PeerCall] Failed to load RNNoise WASM:', err)
      rnnoiseInstance = null
      denoiseState = null
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
    processorNode?.disconnect()
    sourceNode?.disconnect()
  } catch {
    // disconnect() can throw if already disconnected; ignore
  }
  if (processorNode) processorNode.onaudioprocess = null
  processorNode = null
  sourceNode = null
  destinationNode = null
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {})
  }
  audioContext = null
}

/**
 * Build the audio graph on top of `stream`'s first audio track and return
 * a new MediaStream whose audio has been denoised.
 */
function buildGraph(stream: MediaStream): MediaStream {
  if (!rnnoiseInstance || !denoiseState) {
    throw new Error('RNNoise WASM not available')
  }

  audioContext = new AudioContext({ sampleRate: 48000 })
  sourceNode = audioContext.createMediaStreamSource(stream)
  destinationNode = audioContext.createMediaStreamDestination()
  processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1)

  const frameSize = rnnoiseInstance.frameSize
  const inputBuffer = new Float32Array(frameSize)
  let inputOffset = 0

  // Ring buffer of processed frames, consumed by the output drain.
  // Pre-fill with one silent frame so the first drain never underruns:
  // bufferSize (4096) is not a multiple of frameSize (480), so without a
  // cushion the output would get ~256 silence samples on the first chunk
  // and then alternate underruns forever.
  const outputRing: Float32Array[] = [new Float32Array(frameSize)]
  let outputRingHead = 0

  processorNode.onaudioprocess = (event) => {
    if (!denoiseState) return
    const input = event.inputBuffer.getChannelData(0)
    const output = event.outputBuffer.getChannelData(0)

    // 1. Accumulate input into frames and push processed frames to the ring
    for (let i = 0; i < input.length; i++) {
      inputBuffer[inputOffset++] = input[i]
      if (inputOffset >= frameSize) {
        denoiseState.processFrame(inputBuffer)
        outputRing.push(inputBuffer.slice())
        inputOffset = 0
      }
    }

    // 2. Drain ring into output. Pad with silence only as a safety net —
    // the pre-fill should keep the ring non-empty under normal operation.
    for (let i = 0; i < output.length; i++) {
      if (outputRing.length === 0) {
        output[i] = 0
        continue
      }
      const head = outputRing[0]
      output[i] = head[outputRingHead++]
      if (outputRingHead >= head.length) {
        outputRing.shift()
        outputRingHead = 0
      }
    }
  }

  sourceNode.connect(processorNode)
  processorNode.connect(destinationNode)

  return new MediaStream([destinationNode.stream.getAudioTracks()[0], ...stream.getVideoTracks()])
}

/**
 * Enable noise suppression on a MediaStream.
 * Returns a new MediaStream with the cleaned audio track.
 */
export async function enableNoiseSuppression(stream: MediaStream): Promise<MediaStream> {
  await initNoiseSuppression()
  if (!rnnoiseInstance || !denoiseState) {
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
    const processedStream = buildGraph(stream)
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
export function updateNoiseSuppressionSource(stream: MediaStream): MediaStream | null {
  if (!isActive) return null
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) return null

  // Release the stale clone from the previous mic.
  originalAudioTrack?.stop()
  originalAudioTrack = null

  teardownGraph()

  const clone = audioTracks[0].clone()
  try {
    const processedStream = buildGraph(stream)
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
  denoiseState?.destroy()
  denoiseState = null
  rnnoiseInstance = null
}
