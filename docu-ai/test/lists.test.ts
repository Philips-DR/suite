import { describe, expect, it } from 'vitest'
import { bulletRequest } from '../src/emit/lists.js'
import type { docs_v1 } from 'googleapis'

const ranges: docs_v1.Schema$Range[] = [
  { startIndex: 1, endIndex: 5 },
  { startIndex: 6, endIndex: 10 },
  { startIndex: 11, endIndex: 15 },
]

describe('bulletRequest', () => {
  it('spans from the first item’s start to the last item’s end', () => {
    const req = bulletRequest(ranges, { ordered: false, start: 0, end: 3 })
    expect(req.createParagraphBullets?.range).toEqual({ startIndex: 1, endIndex: 15 })
  })

  it('picks the disc preset for unordered, decimal for ordered', () => {
    expect(bulletRequest(ranges, { ordered: false, start: 0, end: 1 }).createParagraphBullets?.bulletPreset).toBe(
      'BULLET_DISC_CIRCLE_SQUARE',
    )
    expect(bulletRequest(ranges, { ordered: true, start: 0, end: 1 }).createParagraphBullets?.bulletPreset).toBe(
      'NUMBERED_DECIMAL_ALPHA_ROMAN',
    )
  })

  it('throws rather than silently styling the wrong paragraphs when the run is out of range', () => {
    expect(() => bulletRequest(ranges, { ordered: false, start: 5, end: 6 })).toThrow(/out of range/)
  })
})
