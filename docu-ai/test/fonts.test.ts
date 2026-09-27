import { describe, expect, it } from 'vitest'
import { FONT_CANDIDATES, VERIFIED_FONTS, assertVerifiedFonts } from '../src/theme/fonts.js'
import { technical } from '../src/theme/presets/technical.js'
import { themeFonts } from '../src/theme/types.js'

describe('font allow-list', () => {
  it('accepts the shipped preset', () => {
    expect(() => assertVerifiedFonts(technical)).not.toThrow()
  })

  it('refuses an unverified font instead of letting Docs quietly render Arial', () => {
    const risky = { ...technical, body: { ...technical.body, text: { font: 'Comic Papyrus', sizePt: 11 } } }
    expect(() => assertVerifiedFonts(risky)).toThrow(/not in VERIFIED_FONTS/)
  })

  it('reports every offending font at once', () => {
    const risky = {
      ...technical,
      body: { ...technical.body, text: { font: 'Fake One', sizePt: 11 } },
      title: { ...technical.title, text: { font: 'Fake Two', sizePt: 26 } },
    }
    expect(() => assertVerifiedFonts(risky)).toThrow(/Fake Two, Fake One|Fake One, Fake Two/)
  })

  it('deduplicates the fonts a theme uses', () => {
    expect(themeFonts(technical)).toEqual(['Inter', 'Source Serif Pro', 'Roboto Mono'])
  })
})

describe('probe candidates', () => {
  // Without both controls a clean report is indistinguishable from a probe that cannot see failure.
  it('carries a positive and a negative control', () => {
    const controls = FONT_CANDIDATES.filter((c) => c.role === 'control')
    expect(controls.map((c) => c.family)).toEqual(['Arial', 'Zzyzx Not A Real Font 42'])
  })

  it('only holds fonts a probe confirmed, never fonts that merely ought to work', () => {
    // Confirmed embedded in the 2026-08-19 probe run.
    expect(VERIFIED_FONTS.has('Roboto Mono')).toBe(true)
    expect(VERIFIED_FONTS.has('Source Serif Pro')).toBe(true)
    // Never probed, so it must not be usable however plausible it looks.
    expect(VERIFIED_FONTS.has('Comic Sans MS')).toBe(false)
    expect(VERIFIED_FONTS.has('Helvetica')).toBe(false)
  })

  it('covers every candidate the probe cleared, so the report is not silently discarded', () => {
    const cleared = FONT_CANDIDATES.filter((c) => c.role !== 'control')
    expect(cleared.every((c) => VERIFIED_FONTS.has(c.family))).toBe(true)
  })

  it('probes a monospace option, which code blocks will need in M2', () => {
    expect(FONT_CANDIDATES.some((c) => c.role === 'mono')).toBe(true)
  })
})
