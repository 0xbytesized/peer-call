/**
 * Mic gain (volume boost/attenuation) pipeline.
 *
 * A tiny AudioContext graph — source → GainNode → destination — that lets
 * the user amplify (or attenuate) their mic before it leaves the browser.
 * Wrapped around whatever audio track is active at the moment (raw mic if
 * NS is off, or the NS-processed track if NS is on).
 *
 * The pipeline does NOT own the input track — the caller is responsible
 * for its lifecycle. `stop()` only disconnects the graph and releases the
 * output track.
 */

export interface GainPipeline {
  readonly input: MediaStreamTrack
  readonly output: MediaStreamTrack
  setGain(value: number): void
  stop(): void
}

export function startGainPipeline(inputTrack: MediaStreamTrack, initialGain: number): GainPipeline {
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(new MediaStream([inputTrack]))
  const gainNode = ctx.createGain()
  gainNode.gain.value = initialGain
  const dest = ctx.createMediaStreamDestination()
  source.connect(gainNode)
  gainNode.connect(dest)

  const outTrack = dest.stream.getAudioTracks()[0]

  return {
    input: inputTrack,
    output: outTrack,
    setGain(v: number) {
      // AudioParam ramp avoids clicks when dragging the slider fast
      const now = ctx.currentTime
      gainNode.gain.cancelScheduledValues(now)
      gainNode.gain.setValueAtTime(gainNode.gain.value, now)
      gainNode.gain.linearRampToValueAtTime(v, now + 0.03)
    },
    stop() {
      try {
        source.disconnect()
        gainNode.disconnect()
      } catch {
        // ignore
      }
      if (ctx.state !== 'closed') ctx.close().catch(() => {})
      dest.stream.getTracks().forEach((t) => t.stop())
    },
  }
}

const GAIN_KEY = 'peercall-mic-gain'

export function loadGain(): number {
  const raw = localStorage.getItem(GAIN_KEY)
  if (raw === null) return 1
  const n = parseFloat(raw)
  if (isNaN(n) || n < 0 || n > 4) return 1
  return n
}

export function saveGain(v: number): void {
  localStorage.setItem(GAIN_KEY, String(v))
}
