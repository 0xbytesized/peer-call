/**
 * RNNoise noise suppression for PeerCall
 *
 * Uses @shiguredo/rnnoise-wasm to process audio in the main thread.
 * Creates a processed MediaStream that replaces the original audio track.
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
 * Pre-load the RNNoise WASM module.
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

  if (!rnnoiseInstance || !denoiseState) {
    throw new Error('RNNoise WASM not available')
  }

  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) return stream

  if (isActive && destinationNode) {
    return new MediaStream([destinationNode.stream.getAudioTracks()[0], ...stream.getVideoTracks()])
  }

  originalStream = stream

  audioContext = new AudioContext({ sampleRate: 48000 })
  sourceNode = audioContext.createMediaStreamSource(stream)
  destinationNode = audioContext.createMediaStreamDestination()

  processorNode = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1)

  const frameSize = rnnoiseInstance.frameSize

  // RNNoise processes frames in-place: it reads from inputBuffer AND writes
  // the denoised result back to the same buffer. So we must:
  // 1. Copy input samples into inputBuffer
  // 2. Call processFrame(inputBuffer) — modifies inputBuffer in-place
  // 3. Copy the now-denoised inputBuffer into the output
  //
  // But we also need outputBuffer to avoid reading denoised data that we're
  // simultaneously overwriting with new input. So we use a separate output
  // staging buffer.
  const inputBuffer = new Float32Array(frameSize)
  const outputBuffer = new Float32Array(frameSize)
  let inputOffset = 0
  let outputReady = 0
  let outputRead = 0

  processorNode.onaudioprocess = (event) => {
    if (!denoiseState) return
    const input = event.inputBuffer.getChannelData(0)
    const output = event.outputBuffer.getChannelData(0)

    let outIdx = 0

    // First, drain any leftover denoised samples from previous round
    while (outputRead < outputReady && outIdx < output.length) {
      output[outIdx++] = outputBuffer[outputRead++]
    }

    // Process input samples frame by frame
    for (let i = 0; i < input.length && outIdx < output.length; i++) {
      inputBuffer[inputOffset++] = input[i]

      if (inputOffset >= frameSize) {
        // Frame complete — process through RNNoise (modifies inputBuffer in-place)
        denoiseState.processFrame(inputBuffer)

        // If we can write directly to output, do it
        if (outIdx + frameSize <= output.length) {
          for (let j = 0; j < frameSize; j++) {
            output[outIdx++] = inputBuffer[j]
          }
        } else {
          // Not enough room in output — stage in outputBuffer for next round
          outputBuffer.set(inputBuffer)
          outputReady = frameSize
          outputRead = 0
          // Write what fits
          while (outIdx < output.length) {
            output[outIdx++] = outputBuffer[outputRead++]
          }
        }

        inputOffset = 0
      }
    }

    // Fill remainder with silence (edge case on first/last buffer)
    while (outIdx < output.length) {
      output[outIdx++] = 0
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
