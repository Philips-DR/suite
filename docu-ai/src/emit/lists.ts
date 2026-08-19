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
 * Consumes the leading tabs it reads, which shortens the text — the reason this is always the last
 * request touching these paragraphs. Callers must apply every ListRun in descending start-index order,
 * since this is the one length-changing request class in an otherwise single-pass M1 build.
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

/** Every ListRun in one call, ordered so applying them in sequence never invalidates a later one. */
export function bulletRequestsDescending(
  ranges: docs_v1.Schema$Range[],
  runs: ListRun[],
): docs_v1.Schema$Request[] {
  return [...runs]
    .sort((a, b) => b.start - a.start)
    .map((run) => bulletRequest(ranges, run))
}
