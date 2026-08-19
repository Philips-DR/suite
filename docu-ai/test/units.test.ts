import { describe, expect, it } from 'vitest'
import { optionalColor, pt, rgb } from '../src/emit/units.js'

describe('pt', () => {
  it('always emits PT, since every dimension in the codebase is authored in points', () => {
    expect(pt(11)).toEqual({ magnitude: 11, unit: 'PT' })
  })
})

describe('rgb', () => {
  it('expands three-digit hex', () => {
    expect(rgb('#fff')).toEqual({ red: 1, green: 1, blue: 1 })
  })

  it('converts six-digit hex to 0..1 floats', () => {
    expect(rgb('#202124')).toEqual({ red: 0.1255, green: 0.1294, blue: 0.1412 })
  })

  it('tolerates a missing leading hash and mixed case', () => {
    expect(rgb('FF0000')).toEqual({ red: 1, green: 0, blue: 0 })
  })

  it('throws rather than silently producing black', () => {
    expect(() => rgb('#12345')).toThrow(/invalid hex/)
    expect(() => rgb('rebeccapurple')).toThrow(/invalid hex/)
  })
})

describe('optionalColor', () => {
  it('wraps in the two levels of nesting the API expects', () => {
    expect(optionalColor('#000')).toEqual({ color: { rgbColor: { red: 0, green: 0, blue: 0 } } })
  })
})
