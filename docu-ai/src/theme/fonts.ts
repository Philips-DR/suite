import type { Theme } from './types.js'
import { themeFonts } from './types.js'

/**
 * WHY THIS FILE EXISTS
 *
 * The Docs API reference for WeightedFontFamily.fontFamily says: "If the font name is unrecognized,
 * the text is rendered in Arial." That substitution happens at RENDER time, not at write time — the
 * API stores whatever string we send it. So a documents.get readback reports the font we asked for
 * whether or not it exists, which means **a readback can never prove a font applied**. It will
 * happily report success while every reader sees Arial.
 *
 * The only way to observe the truth is to export the document to PDF and inspect which fonts were
 * actually embedded. That is what `npm run probe` does.
 *
 * VERIFIED_FONTS is therefore an allow-list, and assertVerifiedFonts() is enforced before any build.
 * It starts with the fonts that ship in the Docs font menu. Add a font only after a probe report
 * shows it embedding — never because it "should" be there.
 */
export const VERIFIED_FONTS = new Set<string>([
  // Every one of these was confirmed embedded in a PDF export by `npm run probe` on 2026-08-19,
  // in a run whose controls both behaved (Arial embedded; a fake font fell back).
  'Arial',
  'Georgia',
  'Merriweather',
  'Lora',
  'PT Serif',
  'Source Serif Pro',
  'EB Garamond',
  'Spectral',
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'IBM Plex Sans',
  'Roboto Slab',
  'Roboto Mono',
  'Courier New',
  'IBM Plex Mono',
  'JetBrains Mono',
  'Source Code Pro',
  'Fira Mono',
  'Space Mono',
  'Inconsolata',
])

export type FontRole = 'body' | 'heading' | 'mono' | 'control'

export interface FontCandidate {
  family: string
  role: FontRole
  note?: string
}

/**
 * The probe's subjects. The two controls are the point: without them, a report where everything
 * passes is indistinguishable from a probe that cannot detect failure at all.
 */
export const FONT_CANDIDATES: FontCandidate[] = [
  { family: 'Arial', role: 'control', note: 'positive control — ships with Docs, must embed' },
  {
    family: 'Zzyzx Not A Real Font 42',
    role: 'control',
    note: 'negative control — MUST fall back to Arial, or the probe is blind',
  },

  { family: 'Georgia', role: 'body' },
  { family: 'Merriweather', role: 'body' },
  { family: 'Lora', role: 'body' },
  { family: 'PT Serif', role: 'body' },
  { family: 'Source Serif Pro', role: 'body' },
  { family: 'EB Garamond', role: 'body' },
  { family: 'Spectral', role: 'body' },

  { family: 'Inter', role: 'heading' },
  { family: 'Roboto', role: 'heading' },
  { family: 'Open Sans', role: 'heading' },
  { family: 'Lato', role: 'heading' },
  { family: 'Montserrat', role: 'heading' },
  { family: 'Poppins', role: 'heading' },
  { family: 'IBM Plex Sans', role: 'heading' },
  { family: 'Roboto Slab', role: 'heading' },

  { family: 'Roboto Mono', role: 'mono' },
  { family: 'Courier New', role: 'mono' },
  { family: 'IBM Plex Mono', role: 'mono' },
  { family: 'JetBrains Mono', role: 'mono' },
  { family: 'Source Code Pro', role: 'mono' },
  { family: 'Fira Mono', role: 'mono' },
  { family: 'Space Mono', role: 'mono' },
  { family: 'Inconsolata', role: 'mono' },
]

export function assertVerifiedFonts(theme: Theme): void {
  const unverified = themeFonts(theme).filter((f) => !VERIFIED_FONTS.has(f))
  if (unverified.length > 0) {
    throw new Error(
      `Theme "${theme.name}" uses fonts that are not in VERIFIED_FONTS: ${unverified.join(', ')}.\n` +
        'Docs silently renders unknown fonts as Arial. Run `npm run probe`, confirm the font embeds ' +
        'in the exported PDF, then add it to VERIFIED_FONTS in src/theme/fonts.ts.',
    )
  }
}
