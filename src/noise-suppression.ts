/**
 * RNNoise noise suppression for PeerCall
 *
 * Uses @shiguredo/rnnoise-wasm to process audio in the main thread.
 * Creates a processed MediaStream that replaces the original audio track.
 *
 * Key: we store a CLONE of the original audio track (not the stream reference)
 * so that we can restore it cleanly when noise suppression is disabled.
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

// Store the original audio track (cloned) so we can restore it later
let originalAudioTrack: MediaStreamTrack | null = null

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

  // Clone the original audio track so we can restore it later
  // (the stream itself may get modified by the caller swapping tracks)
  const originalTrack = audioTracks[0]
  originalAudioTrack = originalTrack.clone()

  audioContext = new AudioContext({ sampleRate: 48000 })
  sourceNode = audioContext.createMediaStreamSource(stream)
  destinationNode = audioContext.createMediaStreamDestination()

  processorNode = audioContext.createScriptProcessor(4096, 1, 1)

  const frameSize = rnnoiseInstance.frameSize
  const inputBuffer = new Float32Array(frameSize)
  let inputOffset = 0

  processorNode.onaudioprocess = (event) => {
    if (!denoiseState) return
    const input = event.inputBuffer.getChannelData(0)
    const output = event.outputBuffer.getChannelData(0)

    let outIdx = 0

    for (let i = 0; i < input.length; i++) {
      inputBuffer[inputOffset++] = input[i]

      if (inputOffset >= frameSize) {
        // processFrame modifies inputBuffer in-place with denoised audio
        denoiseState.processFrame(inputBuffer)

        // Copy denoised samples to output
        for (let j = 0; j < frameSize && outIdx < output.length; j++) {
          output[outIdx++] = inputBuffer[j]
        }
        inputOffset = 0
      }
    }

    // Fill remainder with silence
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
 * Disable noise suppression.
 * Returns the original (cloned) audio track, or null if not active.
 */
export function disableNoiseSuppression(): MediaStreamTrack | null {
  if (!isActive) return null

  // Disconnect and close the audio pipeline
  processorNode?.disconnect()
  sourceNode?.disconnect()
  audioContext?.close()

  processorNode = null
  sourceNode = null
  destinationNode = null
  audioContext = null

  isActive = false

  // Return the cloned original track
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
  disableNoiseSuppression()
  denoiseState?.destroy()
  denoiseState = null
  rnnoiseInstance = null
  originalAudioTrack = null
}
