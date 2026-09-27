import { describe, expect, it } from 'vitest'
import type { docs_v1 } from 'googleapis'
import {
  extractCellParagraphRanges,
  tableCellFills,
  tableEarlyStyleRequests,
  tableInsertRequest,
} from '../src/emit/table.js'
import { plain } from '../src/plan/types.js'
import type { Inline, TableBlock } from '../src/plan/types.js'
import { technical } from '../src/theme/presets/technical.js'

describe('tableInsertRequest', () => {
  it('sizes the request from the parsed grid, appended via endOfSegmentLocation', () => {
    const table: TableBlock = {
      kind: 'table',
      align: [undefined, undefined, undefined],
      rows: [
        [plain('a'), plain('b'), plain('c')],
        [plain('d'), plain('e'), plain('f')],
      ],
    }
    expect(tableInsertRequest(table)).toEqual({
      insertTable: { endOfSegmentLocation: {}, rows: 2, columns: 3 },
    })
  })

  it('reports zero columns for a wholly empty table rather than throwing', () => {
    expect(tableInsertRequest({ kind: 'table', align: [], rows: [] }).insertTable?.columns).toBe(0)
  })
})

/**
 * Modeled directly on a live `documents.get` readback after `insertTable(rows:2, columns:2)`
 * (verified 2026-08-20): a cell's OWN startIndex is not an insertion point — only its first
 * paragraph's startIndex is. This fixture's shape is what makes that distinction testable at all.
 */
function fakeTableElement(): docs_v1.Schema$StructuralElement {
  const emptyParagraph = (start: number): docs_v1.Schema$StructuralElement => ({
    startIndex: start,
    endIndex: start + 1,
    paragraph: { elements: [{ startIndex: start, endIndex: start + 1, textRun: { content: '\n' } }] },
  })
  const cell = (start: number): docs_v1.Schema$TableCell => ({
    startIndex: start - 1,
    endIndex: start + 1,
    content: [emptyParagraph(start)],
  })
  return {
    startIndex: 19,
    endIndex: 31,
    table: {
      rows: 2,
      columns: 2,
      tableRows: [
        { tableCells: [cell(21), cell(23)] },
        { tableCells: [cell(26), cell(28)] },
      ],
    },
  }
}

describe('extractCellParagraphRanges', () => {
  it('extracts the inner paragraph range, not the cell’s own wider bound', () => {
    const ranges = extractCellParagraphRanges(fakeTableElement())
    expect(ranges).toEqual([
      [{ startIndex: 21, endIndex: 22 }, { startIndex: 23, endIndex: 24 }],
      [{ startIndex: 26, endIndex: 27 }, { startIndex: 28, endIndex: 29 }],
    ])
  })

  it('throws on a structural element with no table, rather than returning nonsense', () => {
    expect(() => extractCellParagraphRanges({ paragraph: {} })).toThrow(/requires a StructuralElement.table/)
  })

  it('throws if a cell has no paragraph content, rather than guessing an insertion point', () => {
    const broken: docs_v1.Schema$StructuralElement = {
      table: { tableRows: [{ tableCells: [{ startIndex: 5, endIndex: 6, content: [] }] }] },
    }
    expect(() => extractCellParagraphRanges(broken)).toThrow(/no paragraph/)
  })
})

const cellRanges = extractCellParagraphRanges(fakeTableElement())

describe('tableEarlyStyleRequests', () => {
  const table: TableBlock = {
    kind: 'table',
    align: ['left', undefined],
    rows: [
      [plain('Head0'), plain('Head1')],
      [plain('a'), plain('b')],
    ],
  }
  const requests = tableEarlyStyleRequests(19, cellRanges, table, technical)

  it('pins exactly the header row', () => {
    expect(requests[0]?.pinTableHeaderRows).toEqual({
      tableStartLocation: { index: 19 },
      pinnedHeaderRowsCount: 1,
    })
  })

  it('shades the whole header row in one call, spanning every column', () => {
    const shade = requests.find((r) => r.updateTableCellStyle)?.updateTableCellStyle
    expect(shade?.tableRange).toEqual({
      tableCellLocation: { tableStartLocation: { index: 19 }, rowIndex: 0, columnIndex: 0 },
      rowSpan: 1,
      columnSpan: 2,
    })
    expect(shade?.fields).toBe('background_color')
  })

  it('resets indentStart/indentEnd on every cell, not just some', () => {
    const paraReqs = requests.filter((r) => r.updateParagraphStyle)
    expect(paraReqs).toHaveLength(4) // 2x2 grid
    for (const r of paraReqs) {
      expect(r.updateParagraphStyle?.paragraphStyle?.indentStart).toEqual({ magnitude: 0, unit: 'PT' })
      expect(r.updateParagraphStyle?.paragraphStyle?.indentEnd).toEqual({ magnitude: 0, unit: 'PT' })
    }
  })

  it('maps a left-aligned column to START on both its cells, and leaves an unaligned column alone', () => {
    const byStart = (index: number) =>
      requests.find((r) => r.updateParagraphStyle?.range?.startIndex === index)?.updateParagraphStyle

    for (const index of [21, 26]) {
      const req = byStart(index)
      expect(req?.paragraphStyle?.alignment).toBe('START')
      expect(req?.fields).toContain('alignment')
    }
    for (const index of [23, 28]) {
      const req = byStart(index)
      expect(req?.paragraphStyle?.alignment).toBeUndefined()
      expect(req?.fields).not.toContain('alignment')
    }
  })

  it('maps right and center alignment to END and CENTER respectively', () => {
    const t: TableBlock = { kind: 'table', align: ['right', 'center'], rows: [[plain('x'), plain('y')]] }
    const reqs = tableEarlyStyleRequests(19, [cellRanges[0]!], t, technical)
    const aligns = reqs
      .filter((r) => r.updateParagraphStyle)
      .map((r) => r.updateParagraphStyle?.paragraphStyle?.alignment)
    expect(aligns).toEqual(['END', 'CENTER'])
  })
})

describe('tableCellFills', () => {
  it('fills every non-empty cell at its paragraph’s own startIndex', () => {
    const table: TableBlock = {
      kind: 'table',
      align: [undefined, undefined],
      rows: [
        [plain('Head0'), plain('Head1')],
        [plain('a'), plain('b')],
      ],
    }
    const fills = tableCellFills(cellRanges, table, technical)
    expect(fills).toHaveLength(4)
    expect(fills.map((f) => f.sortIndex)).toEqual([21, 23, 26, 28])
    expect(fills[0]?.requests[0]).toEqual({ insertText: { location: { index: 21 }, text: 'Head0' } })
  })

  it('skips a wholly empty cell — its pre-existing empty paragraph is already correct', () => {
    const table: TableBlock = { kind: 'table', align: [undefined, undefined], rows: [[plain('x'), []]] }
    const fills = tableCellFills([cellRanges[0]!], table, technical)
    expect(fills).toHaveLength(1)
    expect(fills[0]?.sortIndex).toBe(21)
  })

  it('bolds every run in the header row, composing with a run’s own marks', () => {
    const table: TableBlock = {
      kind: 'table',
      align: [undefined, undefined],
      rows: [[[{ kind: 'code', text: 'x' }], plain('Plain')]],
    }
    const fills = tableCellFills([cellRanges[0]!], table, technical)
    const codeCellStyle = fills[0]?.requests[1]?.updateTextStyle?.textStyle
    expect(codeCellStyle?.bold).toBe(true)
    expect(codeCellStyle?.weightedFontFamily?.fontFamily).toBe(technical.code.font) // still mono too
  })

  it('does not bold a data-row cell', () => {
    const table: TableBlock = { kind: 'table', align: [undefined], rows: [plain('Head'), plain('data')].map((p) => [p]) }
    const fills = tableCellFills(cellRanges, table, technical)
    const dataFill = fills.find((f) => f.sortIndex === 26)
    expect(dataFill?.requests).toHaveLength(1) // just the insertText — no bold means no updateTextStyle
  })

  it('styles an inline mark within a cell using the same run-offset arithmetic as a paragraph', () => {
    const table: TableBlock = {
      kind: 'table',
      align: [undefined],
      rows: [
        [plain('Head')],
        [[{ kind: 'text', text: 'see ' }, { kind: 'code', text: 'x' }]],
      ],
    }
    const fills = tableCellFills(cellRanges, table, technical)
    const dataFill = fills.find((f) => f.sortIndex === 26)!
    expect(dataFill.requests[0]).toEqual({ insertText: { location: { index: 26 }, text: 'see x' } })
    const styleReq = dataFill.requests[1]
    expect(styleReq?.updateTextStyle?.range).toEqual({ startIndex: 30, endIndex: 31 }) // 26 + "see ".length
    expect(styleReq?.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily).toBe(technical.code.font)
  })

  // Found building the full real corpus (2026-08-20): a table cell linking to a sibling chapter file
  // is a real pattern (00-overview.md's own "how this doc is organized" table), not a hypothetical.
  // Unlike a paragraph's own chapter link, a cell's must resolve to Link.heading immediately, in the
  // same [fill, style] unit as its own fill — see compile.ts's compileChapterLengthChangingRequests.
  it('resolves a chapterLink run within a cell to Link.heading using the headings passed in', () => {
    const linkCell: Inline[] = [{ kind: 'chapterLink', chapterIndex: 1, children: [{ kind: 'text', text: 'ch2' }] }]
    const table: TableBlock = { kind: 'table', align: [undefined], rows: [plain('Head'), linkCell].map((p) => [p]) }
    const headings = [
      { tabId: 't.ch1', headingId: 'h.one' },
      { tabId: 't.ch2', headingId: 'h.two' },
    ]
    const fills = tableCellFills(cellRanges, table, technical, { headings })
    const dataFill = fills.find((f) => f.sortIndex === 26)!
    expect(dataFill.requests).toHaveLength(2) // the insertText, plus the resolved link style
    expect(dataFill.requests[1]?.updateTextStyle?.range).toEqual({ startIndex: 26, endIndex: 29 })
    expect(dataFill.requests[1]?.updateTextStyle?.textStyle?.link).toEqual({
      heading: { id: 'h.two', tabId: 't.ch2' },
    })
  })

  it('throws rather than silently dropping a cell’s link when no heading was passed in for it', () => {
    const linkCell: Inline[] = [{ kind: 'chapterLink', chapterIndex: 0, children: [{ kind: 'text', text: 'x' }] }]
    const table: TableBlock = { kind: 'table', align: [undefined], rows: [plain('Head'), linkCell].map((p) => [p]) }
    expect(() => tableCellFills(cellRanges, table, technical)).toThrow(/no heading target/)
  })
})
