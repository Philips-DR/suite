import { describe, expect, it } from 'vitest'
import { compact, duration, niceMax, percent, tickValues } from './scale'

describe('niceMax', () => {
  it('ends the axis on a clean number', () => {
    expect(niceMax(25)).toEqual({ max: 30, step: 10 })
    expect(niceMax(13)).toEqual({ max: 15, step: 5 })
  })
  it('keeps a chart of counts on whole steps: never half an action', () => {
    expect(niceMax(3, 4, true)).toEqual({ max: 3, step: 1 })
    expect(niceMax(1, 4, true)).toEqual({ max: 1, step: 1 })
    expect(niceMax(2, 4, true)).toEqual({ max: 2, step: 1 })
    expect(niceMax(1)).toEqual({ max: 1, step: 0.5 }) // a measurement may be fractional
  })
  it('still draws an axis for an empty chart', () => {
    expect(niceMax(0)).toEqual({ max: 4, step: 1 })
  })
  it('reaches the largest value, never less', () => {
    for (const v of [1, 2, 7, 13, 99, 101, 4321, 0.4]) expect(niceMax(v).max).toBeGreaterThanOrEqual(v)
  })
})

describe('tickValues', () => {
  it('lists every step from zero to the maximum', () => {
    expect(tickValues(30, 10)).toEqual([0, 10, 20, 30])
    expect(tickValues(1, 0.25)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })
})

describe('formats', () => {
  it('compacts from a thousand up', () => {
    expect([0, 950, 1000, 1200, 12900, 4_500_000].map(compact)).toEqual(['0', '950', '1K', '1.2K', '12.9K', '4.5M'])
  })
  it('says durations as a person would', () => {
    expect([0.4, 340, 2400, 12_000, 65_000].map(duration)).toEqual(['<1 ms', '340 ms', '2.4 s', '12 s', '1 min 5 s'])
  })
  it('gives a share as a whole percent, and zero of nothing', () => {
    expect(percent(1, 3)).toBe('33%')
    expect(percent(0, 0)).toBe('0%')
  })
})
