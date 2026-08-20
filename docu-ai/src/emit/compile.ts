import type { docs_v1 } from 'googleapis'
import type { Chapter } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import {
  codeBlockStyleRequests,
  compileBlocks,
  quoteStyleRequest,
  ruleStyleRequest,
  type Segment,
} from './blocks.js'
import { bulletRequest } from './lists.js'
import { documentStyleRequest, namedStyleRequests } from './namedStyles.js'
import { extractCellParagraphRanges, tableCellFills, tableEarlyStyleRequests, tableInsertRequest } from './table.js'
import { renderTextBlocks } from './text.js'
import { tabBody } from '../verify/readback.js'

export interface CompiledInserts {
  /** Phase 1: theme, applied before any content so it inherits correctly. */
  themeRequests: docs_v1.Schema$Request[]
  /**
   * Phase 2: every block's raw content, chained via endOfSegmentLocation — text blocks and tables
   * alike. No cursor arithmetic: appending to "the end of the tab" needs no index math, whatever
   * came before it in this same batch.
   */
  insertRequests: docs_v1.Schema$Request[]
  /** Carried through to compileChapterStyleRequests once a readback gives real indices. */
  segments: Segment[]
}

export interface CompiledStyles {
  /** Phase 3: every non-length-changing style — paragraph/run style, borders, table structure. */
  contentRequests: docs_v1.Schema$Request[]
  /** Phase 4: bullets and table cell fills, already sorted descending — see the note below. */
  lengthChangingRequests: docs_v1.Schema$Request[]
}

/**
 * Pure, phase 1+2, for ONE chapter's tab: DocPlan chapter + Theme + that chapter's already-resolved
 * tabId -> theme requests and insert requests, with no network involved. Everything here can be
 * computed with no knowledge of where content actually lands — that's phase 3.
 *
 * One tab per chapter, not one tab for the whole plan: the caller (emit/document.ts) creates every
 * tab first (the only step that needs I/O — a tab's id doesn't exist before Docs assigns it) and
 * calls this once per chapter with the id it got back. No chapter-divider rule here either — that was
 * M1–M3's stand-in for tabs not existing yet; the tab boundary itself is the divider now.
 */
export function compileChapterInserts(theme: Theme, chapter: Chapter, tabId: string): CompiledInserts {
  const segments = compileBlocks(chapter.blocks)

  const insertRequests = segments.map((segment): docs_v1.Schema$Request => {
    if (segment.kind === 'table') return tableInsertRequest(segment.table, tabId)
    // The placeholder startIndex here is never used for anything: only requests[0].insertText.text
    // is read out. Real ranges come from a second call in compileChapterStyleRequests, once a
    // readback gives real indices — see that function's own comment for why a second call, not an
    // offset.
    const text = renderTextBlocks(segment.textBlocks, theme, { startIndex: 1 }).requests[0]?.insertText?.text ?? ''
    return { insertText: { endOfSegmentLocation: { tabId }, text } }
  })

  return {
    themeRequests: [documentStyleRequest(theme, tabId), ...namedStyleRequests(theme, tabId)],
    insertRequests,
    segments,
  }
}

/**
 * Pure, phase 3+4, for ONE chapter's tab: given the readback that followed phase 2's inserts,
 * reconstructs every real index within that tab and builds the rest of the tab's requests. Pure
 * despite taking a live API response as input — no I/O happens here, so it's just as
 * snapshot-testable as compileChapterInserts, against a hand-built fixture Document (see
 * test/compileStyleRequests.test.ts).
 *
 * Looks up `tabId`'s own body via `tabBody`, never `bodies()` (which flattens every tab together —
 * exactly wrong once tabs mean separate, independently-indexed documents), then walks that one tab's
 * structural elements and `segments` IN LOCKSTEP: segment i's expected element count (1 for a table,
 * textBlocks.length for a text run) tells us exactly how many elements to consume before moving to
 * segment i+1. This works because nothing else ever inserts a structural element — a fresh tab's own
 * initial empty paragraph is absorbed by the very first insertText rather than surviving as an extra
 * element, confirmed live before relying on it.
 *
 * A text segment gets `renderTextBlocks` called on it a SECOND time here, now with the real
 * startIndex from the readback, rather than offsetting the placeholder-indexed requests from
 * compileChapterInserts. Both are O(segment size); calling it twice is simpler and cannot drift out
 * of sync with an offsetting transform maintained separately.
 *
 * Table cells are the one case that can't fit the same "compute now, apply later, any order" shape
 * every other block uses: a cell's inline styling (bold, code, links) can only be requested once that
 * text exists, and the fill that creates it is itself length-changing. So a cell's [fill, then style]
 * travels as one unit through the SAME global descending-index sort as bullets — see tableCellFills's
 * own comment. Splitting it into an "early" and "late" half like every other block would let some
 * other length-changing request land between a cell's fill and its own styling and invalidate it.
 * That sort is scoped to this one tab: a Range's index is only ever meaningful within its own tab, so
 * a different chapter's length-changing requests never need interleaving with this tab's.
 */
export function compileChapterStyleRequests(
  doc: docs_v1.Schema$Document,
  tabId: string,
  segments: Segment[],
  theme: Theme,
): CompiledStyles {
  const body = tabBody(doc, tabId)
  if (!body) throw new Error(`no body found for tab ${tabId} in the readback`)

  // Every fresh tab's body opens with an implicit sectionBreak before any content — verified live
  // (2026-08-20): it's invisible in a small hand-inspected probe (neither .paragraph nor .table
  // matches, so a naive "if paragraph ... else if table" walk silently skips it and never reveals
  // it's there), but shows up immediately at real-corpus scale, where it throws the lockstep count off
  // by one. Segments only ever describe paragraphs and tables, so anything else here is filtered out
  // rather than specifically special-cased — robust to whatever else Docs might insert structurally.
  const elements = (body.content ?? []).filter((e) => Boolean(e.paragraph) || Boolean(e.table))
  let cursor = 0

  const contentRequests: docs_v1.Schema$Request[] = []
  const lengthChanging: Array<{ sortIndex: number; requests: docs_v1.Schema$Request[] }> = []

  for (const segment of segments) {
    if (segment.kind === 'table') {
      const element = elements[cursor]
      if (!element?.table) {
        throw new Error(`expected a table structural element at readback position ${cursor}`)
      }
      cursor += 1

      const tableStart = element.startIndex
      if (tableStart == null) throw new Error('table structural element has no startIndex')
      const cellRanges = extractCellParagraphRanges(element)

      contentRequests.push(...tableEarlyStyleRequests(tableStart, cellRanges, segment.table, theme, tabId))
      lengthChanging.push(...tableCellFills(cellRanges, segment.table, theme, tabId))
      continue
    }

    const count = segment.textBlocks.length
    const paragraphElements = elements.slice(cursor, cursor + count)
    if (paragraphElements.length !== count || paragraphElements.some((e) => !e.paragraph)) {
      throw new Error(
        `expected ${count} paragraph elements at readback position ${cursor}, found ` +
          `${paragraphElements.length} (or a non-paragraph among them)`,
      )
    }
    cursor += count

    const realStart = paragraphElements[0]!.startIndex
    if (realStart == null) throw new Error('paragraph structural element has no startIndex')

    const rendered = renderTextBlocks(segment.textBlocks, theme, { startIndex: realStart, tabId })
    contentRequests.push(...rendered.requests.filter((r) => !r.insertText))
    contentRequests.push(...segment.ruleIndices.map((i) => ruleStyleRequest(rendered.ranges[i]!, theme)))
    contentRequests.push(
      ...segment.codeBlockIndices.flatMap((i) => codeBlockStyleRequests(rendered.ranges[i]!, theme)),
    )
    // Shallowest first: a nested blockquote's own call is issued after its enclosing quote's, so its
    // deeper indent/border wins on the sub-range both calls touch.
    contentRequests.push(
      ...[...segment.quoteRuns]
        .sort((a, b) => a.depth - b.depth)
        .map((run) => quoteStyleRequest(rendered.ranges, run, theme)),
    )

    for (const run of segment.listRuns) {
      lengthChanging.push({
        sortIndex: rendered.ranges[run.start]!.startIndex!,
        requests: [bulletRequest(rendered.ranges, run)],
      })
    }
  }

  const lengthChangingRequests = lengthChanging
    .sort((a, b) => b.sortIndex - a.sortIndex)
    .flatMap((entry) => entry.requests)

  return { contentRequests, lengthChangingRequests }
}
