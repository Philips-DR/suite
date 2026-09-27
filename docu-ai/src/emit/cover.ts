import type { docs_v1 } from 'googleapis'
import { plain } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import { renderTextBlocks, type ChapterLinkRange, type TextBlock } from './text.js'

export interface CoverChapterEntry {
  title: string
  tabId: string
}

/**
 * The cover is just a fixed sequence of styled paragraphs — a document title, a "Contents" heading,
 * then one line per chapter — so it reuses `renderTextBlocks` exactly like a chapter's own text
 * segment does, rather than inventing bespoke insert/style logic for a handful of paragraphs.
 */
function coverTextBlocks(title: string, entries: CoverChapterEntry[]): TextBlock[] {
  return [
    { runs: plain(title), style: 'TITLE' },
    { runs: plain('Contents'), style: 'HEADING_2' },
    ...entries.map((e): TextBlock => ({ runs: plain(e.title), style: 'NORMAL_TEXT' })),
  ]
}

/** Phase 2: the cover's raw text, appended to its own tab like any other chapter's content. */
export function coverInsertRequest(
  title: string,
  entries: CoverChapterEntry[],
  theme: Theme,
  tabId: string,
): docs_v1.Schema$Request {
  const text =
    renderTextBlocks(coverTextBlocks(title, entries), theme, { startIndex: 1 }).requests[0]?.insertText
      ?.text ?? ''
  return { insertText: { endOfSegmentLocation: { tabId }, text } }
}

export interface CoverContentStyles {
  requests: docs_v1.Schema$Request[]
  /** One entry per chapter, already tagged with its chapterIndex — for headingLinkRequests once
   * headingIds are known. Same shape as a resolved in-body chapterLink, because it resolves the
   * exact same way (see emit/document.ts's phase 6). */
  entryRanges: ChapterLinkRange[]
}

/**
 * Phase 3/4: paragraph + text styling from the readback's real start index — same shape as a
 * chapter's own text-segment reconstruction. Link styling is deliberately NOT here: a chapter's H1
 * doesn't get its Docs-assigned `headingId` until this exact style pass has actually applied
 * HEADING_1 to it elsewhere in the same build, so linking to it needs a second readback after this
 * one — see emit/text.ts's headingLinkRequests.
 */
export function coverContentStyleRequests(
  title: string,
  entries: CoverChapterEntry[],
  theme: Theme,
  tabId: string,
  realStart: number,
): CoverContentStyles {
  const rendered = renderTextBlocks(coverTextBlocks(title, entries), theme, { startIndex: realStart, tabId })
  return {
    requests: rendered.requests.filter((r) => !r.insertText),
    // Skip the title and "Contents" heading; the remaining ranges are one per chapter, in chapter order.
    entryRanges: rendered.ranges.slice(2).map((range, i) => ({ range, chapterIndex: i })),
  }
}
