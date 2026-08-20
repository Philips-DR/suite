import type { docs_v1 } from 'googleapis'
import type { Inline } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import { flattenInline, type Mark } from './inline.js'
import { textStyleFor, type NamedStyleType } from './namedStyles.js'

/** The first index a document body will accept. Index 0 is not a valid location. */
export const BODY_START = 1

export interface TextBlock {
  runs: Inline[]
  style: NamedStyleType
}

export interface RenderedText {
  requests: docs_v1.Schema$Request[]
  /** One range per block, in order — so callers can style runs without re-deriving the cursor. */
  ranges: docs_v1.Schema$Range[]
  /** One past the final paragraph mark — an accounting value, not necessarily a writable index. */
  endIndex: number
}

/** No style at all: the common case for plain prose, and worth skipping a request over. */
/** Exported for emit/table.ts: a cell's inline marks (code/bold/link/...) compose the same way. */
export function textStyleForMarks(
  marks: Mark[],
  href: string | undefined,
  theme: Theme,
): { style: docs_v1.Schema$TextStyle; fields: string[] } | undefined {
  let style: docs_v1.Schema$TextStyle = {}
  const fields = new Set<string>()

  if (marks.includes('code')) {
    const codeStyle = textStyleFor(theme.code)
    style = { ...style, ...codeStyle.style }
    for (const field of codeStyle.fields) fields.add(field)
  }
  if (marks.includes('bold')) {
    style.bold = true
    fields.add('bold')
  }
  if (marks.includes('italic')) {
    style.italic = true
    fields.add('italic')
  }
  if (marks.includes('strikethrough')) {
    style.strikethrough = true
    fields.add('strikethrough')
  }
  if (href !== undefined) {
    // Setting `link` alone makes Docs apply its own default link colour + underline, which is
    // exactly what we want here — nothing extra to set.
    style.link = { url: href }
    fields.add('link')
  }

  return fields.size > 0 ? { style, fields: [...fields] } : undefined
}

/**
 * Lays out a run of single-paragraph blocks: one insertText for the whole lot, one paragraph style
 * request per block, and one updateTextStyle request per styled inline run (marks or a link — plain
 * prose costs nothing).
 *
 * A running cursor is legitimate *here* and only here, because within a single insert pass every
 * length is known exactly. It must never be carried across a batchUpdate boundary — after the text
 * lands, indices come from a documents.get readback instead.
 */
export function renderTextBlocks(
  blocks: TextBlock[],
  theme: Theme,
  opts: { startIndex?: number; tabId?: string } = {},
): RenderedText {
  const start = opts.startIndex ?? BODY_START
  if (blocks.length === 0) return { requests: [], ranges: [], endIndex: start }

  const flattened = blocks.map((block) => flattenInline(block.runs))
  const blockText = flattened.map((runs) => runs.map((r) => r.text).join(''))

  blockText.forEach((text, i) => {
    if (text.length === 0) {
      throw new Error(
        'renderTextBlocks does not accept a block with no text: a zero-length paragraph has no ' +
          `valid style range (block index ${i}). Empty paragraphs arrive with the full block model.`,
      )
    }
    if (text.includes('\n')) {
      throw new Error(
        `a rendered block must not contain "\\n" (block index ${i}): ${JSON.stringify(text)}. This ` +
          'indicates a raw newline slipped through plan/ instead of becoming a space or "\\v".',
      )
    }
  })

  // Paragraphs are separated by \n and NOT terminated by one. A fresh document already ends with a
  // newline that terminates the final paragraph; adding our own leaves a trailing empty paragraph.
  const combined = blockText.join('\n')

  const location: docs_v1.Schema$Location = { index: start }
  if (opts.tabId !== undefined) location.tabId = opts.tabId
  const requests: docs_v1.Schema$Request[] = [{ insertText: { location, text: combined } }]

  // Indices are UTF-16 code units, which is exactly what String.length returns. Do NOT use
  // [...s].length or count code points: that is correct-looking and wrong for emoji and astral chars.
  const ranges: docs_v1.Schema$Range[] = []
  const runStyleRequests: docs_v1.Schema$Request[] = []
  let cursor = start

  blocks.forEach((block, i) => {
    const paragraphStart = cursor
    const range: docs_v1.Schema$Range = { startIndex: paragraphStart, endIndex: paragraphStart + blockText[i]!.length }
    if (opts.tabId !== undefined) range.tabId = opts.tabId
    ranges.push(range)

    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: block.style },
        fields: 'named_style_type',
      },
    })

    let runCursor = paragraphStart
    for (const run of flattened[i]!) {
      const runRange: docs_v1.Schema$Range = { startIndex: runCursor, endIndex: runCursor + run.text.length }
      if (opts.tabId !== undefined) runRange.tabId = opts.tabId

      const styled = textStyleForMarks(run.marks, run.href, theme)
      if (styled) {
        runStyleRequests.push({
          updateTextStyle: {
            range: runRange,
            textStyle: styled.style,
            fields: styled.fields.join(','),
          },
        })
      }
      runCursor += run.text.length
    }

    cursor = paragraphStart + blockText[i]!.length + 1 // + the \n ending this paragraph
  })

  requests.push(...runStyleRequests)
  return { requests, ranges, endIndex: cursor }
}
