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
import { imageInsertRequests, imageMaxWidthPt, type ImageResolution } from './image.js'
import { bulletRequest } from './lists.js'
import { documentStyleRequest, namedStyleRequests } from './namedStyles.js'
import { extractCellParagraphRanges, tableCellFills, tableEarlyStyleRequests, tableInsertRequest } from './table.js'
import { renderTextBlocks, type ChapterLinkRange } from './text.js'
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

export interface CompiledContent {
  /** Phase 3: every non-length-changing style — paragraph/run style, borders, table structure. */
  contentRequests: docs_v1.Schema$Request[]
  /** Cross-chapter links found in ordinary (non-table-cell) content. A paragraph's text already
   * exists at this point, so its range is stable and safe to resolve later, once every chapter's
   * headingId is known — carried up to emit/document.ts for exactly that. A table cell's own
   * chapter links do NOT come through here; see compileChapterLengthChangingRequests for why. */
  chapterLinkRanges: ChapterLinkRange[]
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
export function compileChapterInserts(
  theme: Theme,
  chapter: Chapter,
  tabId: string,
  imageResolutions: Map<string, ImageResolution>,
): CompiledInserts {
  const segments = compileBlocks(chapter.blocks, imageResolutions)
  const maxWidthPt = imageMaxWidthPt(theme)

  const insertRequests = segments.flatMap((segment): docs_v1.Schema$Request[] => {
    if (segment.kind === 'table') return [tableInsertRequest(segment.table, tabId)]
    if (segment.kind === 'image') {
      return imageInsertRequests(segment.image, segment.naturalWidth, segment.naturalHeight, maxWidthPt, tabId)
    }
    // The placeholder startIndex here is never used for anything: only requests[0].insertText.text
    // is read out. Real ranges come from a second call in compileChapterStyleRequests, once a
    // readback gives real indices — see that function's own comment for why a second call, not an
    // offset.
    const text = renderTextBlocks(segment.textBlocks, theme, { startIndex: 1 }).requests[0]?.insertText?.text ?? ''
    return [{ insertText: { endOfSegmentLocation: { tabId }, text } }]
  })

  return {
    themeRequests: [documentStyleRequest(theme, tabId), ...namedStyleRequests(theme, tabId)],
    insertRequests,
    segments,
  }
}

type MatchedSegment =
  | { kind: 'table'; segment: Extract<Segment, { kind: 'table' }>; tableStart: number; cellRanges: docs_v1.Schema$Range[][] }
  | { kind: 'text'; segment: Extract<Segment, { kind: 'text' }>; realStart: number }
  | { kind: 'image' }

/**
 * Looks up `tabId`'s own body via `tabBody`, never `bodies()` (which flattens every tab together —
 * exactly wrong once tabs mean separate, independently-indexed documents), then walks that one tab's
 * structural elements and `segments` IN LOCKSTEP: segment i's expected element count (1 for a table
 * or an image, textBlocks.length for a text run) tells us exactly how many elements to consume before
 * moving to segment i+1. This works because nothing else ever inserts a structural element — a fresh
 * tab's own initial empty paragraph is absorbed by the very first insertText rather than surviving as
 * an extra element, confirmed live before relying on it.
 *
 * An image segment consumes exactly one paragraph element too, not zero: verified live (see
 * plan.md's M8 note) that an inline image inserted via endOfSegmentLocation, flanked by the leading
 * and trailing '\n' emit/image.ts's imageInsertRequests supplies, lands in its OWN paragraph — the
 * leading '\n' terminates whatever paragraph preceded it (already accounted for by THAT segment's own
 * element count) rather than creating a paragraph of its own, so only the image's own [image, '\n']
 * paragraph is new here.
 *
 * Shared between compileChapterContentRequests and compileChapterLengthChangingRequests, which call
 * it against two different readbacks (see the latter's own comment for why two) but need the exact
 * same matching/defensive-throw logic against each — extracting it once is what keeps the two from
 * silently drifting apart if this matching logic ever changes.
 */
function matchSegmentsToElements(doc: docs_v1.Schema$Document, tabId: string, segments: Segment[]): MatchedSegment[] {
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

  return segments.map((segment): MatchedSegment => {
    if (segment.kind === 'table') {
      const element = elements[cursor]
      if (!element?.table) {
        throw new Error(`expected a table structural element at readback position ${cursor}`)
      }
      cursor += 1

      const tableStart = element.startIndex
      if (tableStart == null) throw new Error('table structural element has no startIndex')
      return { kind: 'table', segment, tableStart, cellRanges: extractCellParagraphRanges(element) }
    }

    if (segment.kind === 'image') {
      const element = elements[cursor]
      if (!element?.paragraph) {
        throw new Error(`expected the image's own paragraph element at readback position ${cursor}`)
      }
      cursor += 1
      return { kind: 'image' }
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
    return { kind: 'text', segment, realStart }
  })
}

/**
 * Pure, phase 3, for ONE chapter's tab: given the readback that followed phase 2's inserts,
 * reconstructs every real index within that tab and builds every non-length-changing style request —
 * paragraph/run style, borders, table structure. Pure despite taking a live API response as input —
 * no I/O happens here, so it's just as snapshot-testable as compileChapterInserts, against a
 * hand-built fixture Document (see test/compileStyleRequests.test.ts).
 *
 * A text segment gets `renderTextBlocks` called on it a SECOND time here, now with the real
 * startIndex from the readback, rather than offsetting the placeholder-indexed requests from
 * compileChapterInserts. Both are O(segment size); calling it twice is simpler and cannot drift out
 * of sync with an offsetting transform maintained separately.
 */
export function compileChapterContentRequests(
  doc: docs_v1.Schema$Document,
  tabId: string,
  segments: Segment[],
  theme: Theme,
): CompiledContent {
  const matched = matchSegmentsToElements(doc, tabId, segments)
  const contentRequests: docs_v1.Schema$Request[] = []
  const chapterLinkRanges: ChapterLinkRange[] = []

  for (const m of matched) {
    if (m.kind === 'table') {
      contentRequests.push(...tableEarlyStyleRequests(m.tableStart, m.cellRanges, m.segment.table, theme, tabId))
      continue
    }
    // An image needs no further styling — its size and position were already fully specified in its
    // own insertInlineImage request at insert time; nothing here to add.
    if (m.kind === 'image') continue

    const rendered = renderTextBlocks(m.segment.textBlocks, theme, { startIndex: m.realStart, tabId })
    chapterLinkRanges.push(...rendered.chapterLinkRanges)
    contentRequests.push(...rendered.requests.filter((r) => !r.insertText))
    contentRequests.push(...m.segment.ruleIndices.map((i) => ruleStyleRequest(rendered.ranges[i]!, theme)))
    contentRequests.push(
      ...m.segment.codeBlockIndices.flatMap((i) => {
        const highlighted = m.segment.textBlocks[i]!.runs.some((r) => r.kind === 'codeToken')
        return codeBlockStyleRequests(rendered.ranges[i]!, theme, highlighted)
      }),
    )
    // Shallowest first: a nested blockquote's own call is issued after its enclosing quote's, so its
    // deeper indent/border wins on the sub-range both calls touch.
    contentRequests.push(
      ...[...m.segment.quoteRuns]
        .sort((a, b) => a.depth - b.depth)
        .map((run) => quoteStyleRequest(rendered.ranges, run, theme)),
    )
  }

  return { contentRequests, chapterLinkRanges }
}

/**
 * Pure, phase 4, for ONE chapter's tab: table cell fills and bullets, the only requests in a build
 * that change document length — sorted descending so an earlier fill/bullet in this tab is never
 * invalidated by a later one that already landed.
 *
 * Needs a SECOND readback (taken after compileChapterContentRequests' own batch has landed) for two
 * independent reasons that happen to be satisfied by the same readback: cell positions haven't moved
 * since phase 3 touched nothing length-changing, but every chapter's headingId now exists too (phase
 * 3's own batch is what applies HEADING_1) — and a cell's chapter-crossing link can only resolve to
 * Link.heading using one.
 *
 * This is why a table cell's chapter link resolves at a different time than an ordinary paragraph's:
 * a paragraph's own text already existed at phase 3's readback, so its link range is stable and can
 * wait for a later phase (see emit/document.ts's own phase 6) — a cell's text doesn't exist until
 * THIS phase fills it, so its link must resolve inside the same atomic [fill, style] unit as the fill
 * itself, per tableCellFills's own long-standing rule that a cell's fill and style can never be split
 * apart: some other length-changing request landing between them would invalidate one half.
 */
export function compileChapterLengthChangingRequests(
  doc: docs_v1.Schema$Document,
  tabId: string,
  segments: Segment[],
  theme: Theme,
  headings: Array<{ tabId: string; headingId: string }>,
): docs_v1.Schema$Request[] {
  const matched = matchSegmentsToElements(doc, tabId, segments)
  const lengthChanging: Array<{ sortIndex: number; requests: docs_v1.Schema$Request[] }> = []

  for (const m of matched) {
    if (m.kind === 'table') {
      lengthChanging.push(...tableCellFills(m.cellRanges, m.segment.table, theme, { tabId, headings }))
      continue
    }
    if (m.kind === 'image') continue

    const rendered = renderTextBlocks(m.segment.textBlocks, theme, { startIndex: m.realStart, tabId })
    for (const run of m.segment.listRuns) {
      lengthChanging.push({
        sortIndex: rendered.ranges[run.start]!.startIndex!,
        requests: [bulletRequest(rendered.ranges, run)],
      })
    }
  }

  return lengthChanging.sort((a, b) => b.sortIndex - a.sortIndex).flatMap((entry) => entry.requests)
}
