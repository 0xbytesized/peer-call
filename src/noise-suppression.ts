/**
 * RNNoise noise suppression for PeerCall
 *
 * Uses @shiguredo/rnnoise-wasm to process audio in the main thread.
 * Creates a processed MediaStream that replaces the original audio track.
 *
 * Lazy-loads the WASM module only when noise suppression is first enabled.
 */

import type { Rnnoise } from '@shiguredo/rnnoise-wasm'

let RnnoiseClass: typeof Rnnoise | null = null
let rnnoiseInstance: Rnnoise | null = null
let denoiseState: ReturnType<Rnnoise['createDenoiseState']> | null = null
let isActive = false

// Audio processing nodes
let audioContext: AudioContext | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let destinationNode: MediaStreamAudioDestinationNode | null = null
let processorNode: ScriptProcessorNode | null = null
let originalStream: MediaStream | null = null

const PROCESSOR_BUFFER_SIZE = 4096

/**
 * Load RNNoise WASM module lazily. Called automatically when enabling
 * noise suppression for the first time.
 */
async function ensureRnnoiseLoaded(): Promise<typeof Rnnoise> {
  if (RnnoiseClass) return RnnoiseClass
  const mod = await import('@shiguredo/rnnoise-wasm')
  RnnoiseClass = mod.Rnnoise
  return RnnoiseClass
}

/**
 * Pre-load the RNNoise WASM module. Call this early (e.g. on page load)
 * so it's ready when the user enables noise suppression.
 */
export async function initNoiseSuppression(): Promise<void> {
  if (rnnoiseInstance) return
  const Rn = await ensureRnnoiseLoaded()
  rnnoiseInstance = await Rn.load()
  denoiseState = rnnoiseInstance.createDenoiseState()
}

/**
 * Enable noise suppression on a MediaStream.
 * Returns a new MediaStream with the cleaned audio track.
 * Lazily loads RNNoise WASM on first call.
 */
export async function enableNoiseSuppression(stream: MediaStream): Promise<MediaStream> {
  if (!rnnoiseInstance || !denoiseState) {
    await initNoiseSuppression()
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

  // We use ScriptProcessorNode because AudioWorklet can't load WASM asynchronously
  // in all browsers. ScriptProcessorNode is deprecated but works everywhere and
  // for our use case (processing 1 audio track) the performance impact is minimal.

  processorNode = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1)

  const frameSize = rnnoiseInstance!.frameSize
  const inputBuffer = new Float32Array(frameSize)
  let inputOffset = 0

  processorNode.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const output = event.outputBuffer.getChannelData(0)
    const state = denoiseState!

    let processedIndex = 0
    let bufOffset = inputOffset

    // Fill the input buffer from the audio event data
    for (let i = 0; i < input.length; i++) {
      inputBuffer[bufOffset] = input[i]
      bufOffset++

      if (bufOffset >= frameSize) {
        // Process a complete frame through RNNoise
        state.processFrame(inputBuffer)
        // Copy processed frame to output
        for (let j = 0; j < frameSize && processedIndex < output.length; j++) {
          output[processedIndex] = inputBuffer[j]
          processedIndex++
        }
        bufOffset = 0
      }
    }
    inputOffset = bufOffset

    // Fill any remaining output with silence (shouldn't happen often)
    while (processedIndex < output.length) {
      output[processedIndex] = 0
      processedIndex++
    }
  }

  sourceNode.connect(processorNode)
  processorNode.connect(destinationNode)

  isActive = true

  // Return new stream: processed audio + original video tracks
  const processedStream = new MediaStream([destinationNode.stream.getAudioTracks()[0], ...stream.getVideoTracks()])

  return processedStream
}

/**
 * Disable noise suppression and return to the original audio stream.
 */
export function disableNoiseSuppression(): MediaStream | null {
  if (!isActive || !originalStream) return null

  // Disconnect processing pipeline
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
