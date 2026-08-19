import { describe, expect, it } from 'vitest'
import { verdictFor } from '../src/verify/pdfFonts.js'

describe('verdictFor', () => {
  it('matches through a PDF subset prefix that has already been stripped', () => {
    expect(verdictFor('Lora', ['Lora', 'Arial'])).toEqual({
      requested: 'Lora',
      applied: true,
      matchedAs: 'Lora',
    })
  })

  it('ignores spaces and punctuation when comparing family names', () => {
    expect(verdictFor('IBM Plex Mono', ['IBMPlexMono-Regular']).applied).toBe(true)
  })

  it('calls a font missing when only Arial came back', () => {
    expect(verdictFor('JetBrains Mono', ['Arial', 'ArialMT'])).toEqual({
      requested: 'JetBrains Mono',
      applied: false,
      matchedAs: undefined,
    })
  })

  it('still confirms Arial when Arial is what was asked for', () => {
    expect(verdictFor('Arial', ['ArialMT']).applied).toBe(true)
  })
})
