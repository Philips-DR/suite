import type { docs_v1 } from 'googleapis'

export interface ListRun {
  ordered: boolean
  /** [start, end) — indices into the same TextBlock/Range array compileBlocks produced them from. */
  start: number
  end: number
}

/**
 * One request per contiguous run of list items, spanning every item's range. createParagraphBullets
 * reads each paragraph's own leading-tab count within that span to infer its nesting level, which is
 * why compileBlocks prefixes each item's text with `\t.repeat(depth)` rather than passing depth here.
 *
 * Consumes the leading tabs it reads, which shortens the text — the reason this belongs in the
 * length-changing phase, applied in descending start-index order alongside every other request that
 * changes document length (table cell fills included — see emit/compile.ts's global sort).
 */
export function bulletRequest(ranges: docs_v1.Schema$Range[], run: ListRun): docs_v1.Schema$Request {
  const first = ranges[run.start]
  const last = ranges[run.end - 1]
  if (!first || !last) throw new Error(`ListRun [${run.start}, ${run.end}) is out of range`)

  const range: docs_v1.Schema$Range = { startIndex: first.startIndex, endIndex: last.endIndex }
  if (first.tabId !== undefined) range.tabId = first.tabId

  return {
    createParagraphBullets: {
      range,
      bulletPreset: run.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
    },
  }
}
