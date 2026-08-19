import type { docs_v1 } from 'googleapis'
import type { Hex } from '../theme/types.js'

/** Every dimension in this codebase goes through here. Never write a bare {magnitude, unit} literal. */
export function pt(magnitude: number): docs_v1.Schema$Dimension {
  return { magnitude, unit: 'PT' }
}

function round(n: number): number {
  // 4dp keeps snapshots readable; the worst-case channel error is ~0.01/255, i.e. invisible.
  return Math.round(n * 10000) / 10000
}

export function rgb(hex: Hex): docs_v1.Schema$RgbColor {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`invalid hex colour: ${JSON.stringify(hex)}`)
  let digits = match[1]
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const n = Number.parseInt(digits, 16)
  return {
    red: round(((n >> 16) & 0xff) / 255),
    green: round(((n >> 8) & 0xff) / 255),
    blue: round((n & 0xff) / 255),
  }
}

/** Colours are authored as hex in theme/ and converted here — 0..1 floats are unreviewable by hand. */
export function optionalColor(hex: Hex): docs_v1.Schema$OptionalColor {
  return { color: { rgbColor: rgb(hex) } }
}
