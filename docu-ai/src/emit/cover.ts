import type { docs_v1 } from 'googleapis'
import { plain } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import { renderTextBlocks, type TextBlock } from './text.js'

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
  /** One range per chapter entry, in order — for coverLinkRequests once headingIds are known. */
  entryRanges: docs_v1.Schema$Range[]
}

/**
 * Phase 3/4: paragraph + text styling from the readback's real start index — same shape as a
 * chapter's own text-segment reconstruction. Link styling is deliberately NOT here: a chapter's H1
 * doesn't get its Docs-assigned `headingId` until this exact style pass has actually applied
 * HEADING_1 to it elsewhere in the same build, so linking to it needs a second readback after this
 * one — see coverLinkRequests.
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
    entryRanges: rendered.ranges.slice(2), // skip the title and "Contents" heading
  }
}

/**
 * Phase 6, after a second readback: turn each entry into a clickable jump to that chapter's own
 * first heading. `Link.heading` (not the legacy bare `headingId`) is required once a document has
 * more than one tab — verified live (2026-08-20) that Docs both accepts and correctly reads back
 * `{heading: {id, tabId}}`, auto-applying its own default link colour + underline exactly like a
 * plain URL link does.
 */
export function coverLinkRequests(
  entryRanges: docs_v1.Schema$Range[],
  headings: Array<{ tabId: string; headingId: string }>,
): docs_v1.Schema$Request[] {
  return entryRanges.map((range, i) => {
    const heading = headings[i]
    if (!heading) throw new Error(`no heading target for cover entry ${i}`)
    return {
      updateTextStyle: {
        range,
        textStyle: { link: { heading: { id: heading.headingId, tabId: heading.tabId } } },
        fields: 'link',
      },
    }
  })
}
