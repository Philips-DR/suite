// The loud and quiet of a real file, as a few hundred peaks to draw. Decoding happens in the browser at a
// low sample rate, so even a long chapter is cheap; a file too large to decode comfortably gets no waveform
// (the player draws a plain track instead) rather than a made-up one.

import { useEffect, useState } from 'react'

export const WAVE_MAX_BYTES = 24 * 1024 * 1024
export const WAVE_RATE = 8000
export const WAVE_BUCKETS = 480

export interface Wave { state: 'loading' | 'ready' | 'none'; peaks: Float32Array; seconds: number }
const NONE: Wave = { state: 'none', peaks: new Float32Array(0), seconds: 0 }

/** The largest absolute sample in each of `buckets` equal slices, scaled so the loudest is 1 and lifted a
 *  little (a power below 1) so quiet speech still shows. Silence stays flat; an empty signal is all zeros. */
export function peaksOf(data: Float32Array, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets)
  if (data.length === 0 || buckets <= 0) return peaks
  const per = data.length / buckets
  let top = 0
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per)
    const to = Math.max(from + 1, Math.floor((b + 1) * per))
    let peak = 0
    for (let i = from; i < Math.min(to, data.length); i++) {
      const v = Math.abs(data[i]!)
      if (v > peak) peak = v
    }
    peaks[b] = peak
    if (peak > top) top = peak
  }
  if (top > 0) for (let b = 0; b < buckets; b++) peaks[b] = Math.pow(peaks[b]! / top, 0.65)
  return peaks
}

export function useWaveform(blob: Blob | null): Wave {
  const [wave, setWave] = useState<Wave>(NONE)
  useEffect(() => {
    if (!blob || blob.size > WAVE_MAX_BYTES || typeof OfflineAudioContext === 'undefined') { setWave(NONE); return }
    let cancelled = false
    setWave({ state: 'loading', peaks: NONE.peaks, seconds: 0 })
    ;(async () => {
      const context = new OfflineAudioContext(1, 1, WAVE_RATE) // decoded and resampled to a small mono signal
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      const peaks = peaksOf(decoded.getChannelData(0), WAVE_BUCKETS)
      if (!cancelled) setWave({ state: 'ready', peaks, seconds: decoded.duration })
    })().catch(() => { if (!cancelled) setWave(NONE) }) // a format this browser cannot decode: the plain track
    return () => { cancelled = true }
  }, [blob])
  return wave
}
