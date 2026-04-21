/**
 * RNNoise noise suppression for PeerCall
 *
 * Uses @shiguredo/rnnoise-wasm to process audio in the main thread.
 * Creates a processed MediaStream that replaces the original audio track.
 *
 * The WASM binary is loaded lazily by Rnnoise.load() — only downloaded
 * when the user first enables noise suppression.
 */

import { Rnnoise } from '@shiguredo/rnnoise-wasm'

let rnnoiseInstance: Rnnoise | null = null
let denoiseState: ReturnType<Rnnoise['createDenoiseState']> | null = null
let isActive = false
let loading = false

// Audio processing nodes
let audioContext: AudioContext | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let destinationNode: MediaStreamAudioDestinationNode | null = null
let processorNode: ScriptProcessorNode | null = null
let originalStream: MediaStream | null = null

const PROCESSOR_BUFFER_SIZE = 4096

/**
 * Pre-load the RNNoise WASM module. Call this early (e.g. on page load)
 * so it's ready when the user enables noise suppression.
 */
export async function initNoiseSuppression(): Promise<void> {
  if (rnnoiseInstance || loading) return
  loading = true
  try {
    rnnoiseInstance = await Rnnoise.load()
    denoiseState = rnnoiseInstance.createDenoiseState()
  } catch (err) {
    console.error('[PeerCall] Failed to load RNNoise WASM:', err)
    rnnoiseInstance = null
    denoiseState = null
  } finally {
    loading = false
  }
}

/**
 * Enable noise suppression on a MediaStream.
 * Returns a new MediaStream with the cleaned audio track.
 */
export async function enableNoiseSuppression(stream: MediaStream): Promise<MediaStream> {
  if (!rnnoiseInstance || !denoiseState) {
    await initNoiseSuppression()
  }

  // If WASM failed to load, return the original stream unchanged
  if (!rnnoiseInstance || !denoiseState) {
    throw new Error('RNNoise WASM not available')
  }

  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) return stream

  // If already processing, return the processed stream
  if (isActive && destinationNode) {
    return new MediaStream([destinationNode.stream.getAudioTracks()[0], ...stream.getVideoTracks()])
  }

  // Store original stream for later cleanup
  originalStream = stream

  // Create audio processing pipeline
  audioContext = new AudioContext({ sampleRate: 48000 })
  sourceNode = audioContext.createMediaStreamSource(stream)
  destinationNode = audioContext.createMediaStreamDestination()

  processorNode = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1)

  const frameSize = rnnoiseInstance.frameSize
  const inputBuffer = new Float32Array(frameSize)
  let inputOffset = 0

  processorNode.onaudioprocess = (event) => {
    if (!denoiseState) return
    const input = event.inputBuffer.getChannelData(0)
    const output = event.outputBuffer.getChannelData(0)

    let processedIndex = 0
    let bufOffset = inputOffset

    for (let i = 0; i < input.length; i++) {
      inputBuffer[bufOffset] = input[i]
      bufOffset++

      if (bufOffset >= frameSize) {
        denoiseState.processFrame(inputBuffer)
        for (let j = 0; j < frameSize && processedIndex < output.length; j++) {
          output[processedIndex] = inputBuffer[j]
          processedIndex++
        }
        bufOffset = 0
      }
    }
    inputOffset = bufOffset

    while (processedIndex < output.length) {
      output[processedIndex] = 0
      processedIndex++
    }
  }

  sourceNode.connect(processorNode)
  processorNode.connect(destinationNode)

  isActive = true

  return new MediaStream([destinationNode.stream.getAudioTracks()[0], ...stream.getVideoTracks()])
}

/**
 * Disable noise suppression and return to the original audio stream.
 */
export function disableNoiseSuppression(): MediaStream | null {
  if (!isActive || !originalStream) return null

  processorNode?.disconnect()
  sourceNode?.disconnect()
  audioContext?.close()

  processorNode = null
  sourceNode = null
  destinationNode = null
  audioContext = null

  isActive = false

  return originalStream
}

/**
 * Check if noise suppression is currently active.
 */
export function isNoiseSuppressionActive(): boolean {
  return isActive
}

/**
 * Clean up all resources. Call this when leaving the call.
 */
export function cleanupNoiseSuppression(): void {
  disableNoiseSuppression()
  denoiseState?.destroy()
  denoiseState = null
  rnnoiseInstance = null
  originalStream = null
}
