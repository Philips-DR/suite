import type { docs_v1 } from 'googleapis'
import type { TableBlock } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import { flattenInline } from './inline.js'
import { textStyleForMarks } from './text.js'
import { optionalColor, pt } from './units.js'

export function tableInsertRequest(table: TableBlock, tabId?: string): docs_v1.Schema$Request {
  const columns = table.rows[0]?.length ?? 0
  const endOfSegmentLocation: docs_v1.Schema$EndOfSegmentLocation = {}
  if (tabId !== undefined) endOfSegmentLocation.tabId = tabId
  return { insertTable: { endOfSegmentLocation, rows: table.rows.length, columns } }
}

/**
 * A fresh table cell's insertion point is its first paragraph's OWN range — never the cell's own
 * `startIndex`. Verified live: Docs rejects an insertText at a raw cell.startIndex with "the
 * insertion index must be inside the bounds of an existing paragraph" — a cell wraps a paragraph,
 * it isn't one. `[row][col]` gives that inner paragraph's `{startIndex, endIndex}` (empty, so
 * start+1 == end: just the paragraph's own implicit newline).
 */
export function extractCellParagraphRanges(
  element: docs_v1.Schema$StructuralElement,
): docs_v1.Schema$Range[][] {
  const table = element.table
  if (!table) throw new Error('extractCellParagraphRanges requires a StructuralElement.table')
  return (table.tableRows ?? []).map((row) =>
    (row.tableCells ?? []).map((cell) => {
      const firstParagraph = cell.content?.find((c) => c.paragraph)
      if (firstParagraph?.startIndex === undefined || firstParagraph.endIndex === undefined) {
        throw new Error('table cell has no paragraph — cannot determine an insertion point')
      }
      return { startIndex: firstParagraph.startIndex, endIndex: firstParagraph.endIndex }
    }),
  )
}

/**
 * Structural table properties — pinning, header shading, per-cell paragraph resets — none of which
 * depend on cell text existing, so all of it is safe in the same early, non-length-changing phase as
 * every other block's styling. Uses the pre-fill readback ranges: nothing has shrunk or grown yet.
 *
 * Every cell's paragraph gets indentStart/indentEnd reset to 0 explicitly: NORMAL_TEXT's own
 * indentEnd (72pt, narrowing the page-width prose column) would otherwise be inherited straight into
 * a cell a fraction of that width — CLAUDE.md's "never rely on inheritance across a block boundary"
 * rule applies here as much as it does to code blocks.
 */
export function tableEarlyStyleRequests(
  tableStartIndex: number,
  cellRanges: docs_v1.Schema$Range[][],
  table: TableBlock,
  theme: Theme,
  tabId?: string,
): docs_v1.Schema$Request[] {
  const tableStartLocation: docs_v1.Schema$Location = { index: tableStartIndex }
  if (tabId !== undefined) tableStartLocation.tabId = tabId
  const columns = table.rows[0]?.length ?? 0
  const requests: docs_v1.Schema$Request[] = []

  requests.push({ pinTableHeaderRows: { tableStartLocation, pinnedHeaderRowsCount: 1 } })

  if (columns > 0) {
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: { tableStartLocation, rowIndex: 0, columnIndex: 0 },
          rowSpan: 1,
          columnSpan: columns,
        },
        tableCellStyle: { backgroundColor: optionalColor(theme.table.headerShading) },
        fields: 'background_color',
      },
    })
  }

  for (const row of cellRanges) {
    row.forEach((range, c) => {
      const align = table.align[c]
      const paragraphStyle: docs_v1.Schema$ParagraphStyle = { indentStart: pt(0), indentEnd: pt(0) }
      const fields = ['indent_start', 'indent_end']
      if (align !== undefined) {
        paragraphStyle.alignment = align === 'left' ? 'START' : align === 'right' ? 'END' : 'CENTER'
        fields.push('alignment')
      }
      const scoped = tabId !== undefined ? { ...range, tabId } : range
      requests.push({ updateParagraphStyle: { range: scoped, paragraphStyle, fields: fields.join(',') } })
    })
  }

  return requests
}

/**
 * The length-changing half: filling each cell's text, and — critically — styling that SAME cell's
 * inline marks right alongside it, in the same slot. A cell's bold/code/link runs can't be styled
 * before the text exists, so unlike every other block (where text was inserted up front and styling
 * is pure range math), a table cell's [fill, then style] must travel together as one unit through
 * the global descending-index sort in emit/compile.ts — unless it does, an intervening fill
 * elsewhere in the document could invalidate one half without the other.
 *
 * The header row gets bold added to every run, composing with whatever marks the cell already
 * carries (so a bold, code-styled header cell still renders as bold + mono, not one or the other).
 */
export interface CellFill {
  /** Sort key for the global descending pass: this cell's own pre-fill insertion index. */
  sortIndex: number
  requests: docs_v1.Schema$Request[]
}

export function tableCellFills(
  cellRanges: docs_v1.Schema$Range[][],
  table: TableBlock,
  theme: Theme,
  tabId?: string,
): CellFill[] {
  const fills: CellFill[] = []

  table.rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      const range = cellRanges[r]?.[c]
      if (!range) throw new Error(`no readback range for cell r${r}c${c}`)

      let runs = flattenInline(cell)
      if (r === 0) {
        runs = runs.map((run) => (run.marks.includes('bold') ? run : { ...run, marks: [...run.marks, 'bold'] }))
      }
      const text = runs.map((run) => run.text).join('')
      if (text.length === 0) return // the cell's existing empty paragraph is already correct

      const insertionIndex = range.startIndex!
      const location: docs_v1.Schema$Location = { index: insertionIndex }
      if (tabId !== undefined) location.tabId = tabId
      const requests: docs_v1.Schema$Request[] = [{ insertText: { location, text } }]

      let cursor = insertionIndex
      for (const run of runs) {
        const styled = textStyleForMarks(run.marks, run.href, theme)
        if (styled) {
          const runRange: docs_v1.Schema$Range = { startIndex: cursor, endIndex: cursor + run.text.length }
          if (tabId !== undefined) runRange.tabId = tabId
          requests.push({
            updateTextStyle: { range: runRange, textStyle: styled.style, fields: styled.fields.join(',') },
          })
        }
        cursor += run.text.length
      }

      fills.push({ sortIndex: insertionIndex, requests })
    })
  })

  return fills
}
