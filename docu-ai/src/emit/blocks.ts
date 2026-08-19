import type { docs_v1 } from 'googleapis'
import type { Block, Inline } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import { flattenInline, plainText } from './inline.js'
import { pt, optionalColor } from './units.js'
import { textStyleFor, type NamedStyleType } from './namedStyles.js'
import type { TextBlock } from './text.js'
import type { ListRun } from './lists.js'

/** A contiguous run of TextBlocks produced from inside one `>` blockquote, however deeply nested. */
export interface QuoteRun {
  depth: number
  start: number
  end: number
}

export interface CompiledBlocks {
  textBlocks: TextBlock[]
  listRuns: ListRun[]
  /** Indices into textBlocks/ranges of a `{kind: 'rule'}` block's placeholder paragraph. */
  ruleIndices: number[]
  /** Indices into textBlocks/ranges of a fenced code block's single, \v-joined paragraph. */
  codeBlockIndices: number[]
  quoteRuns: QuoteRun[]
}

function headingStyle(level: 1 | 2 | 3 | 4 | 5 | 6): NamedStyleType {
  // Levels 4–6 are valid Docs styles but the technical preset only redefines 1–3 (the fixture corpus
  // never nests past H3); Docs' own default look applies to anything deeper rather than erroring.
  return `HEADING_${level}` as NamedStyleType
}

/** A table cell's rich content, degraded to plain text until M3 gives tables real cell styling. */
function cellText(cell: Inline[]): string {
  const text = plainText(flattenInline(cell))
  return text.length > 0 ? text : ' '
}

/**
 * A fenced code block as ONE paragraph: each source line becomes a plain-text run, joined by `{kind:
 * 'break'}` — the same inline node markdown hard breaks use, which emit/inline.ts turns into a literal
 * `\v`. One paragraph means one shading/border/spacing application covers the whole block with no
 * per-line gaps, and `keepLinesTogether` (applied in codeBlockStyleRequest) has something meaningful
 * to hold together. A blank source line becomes a single space: every line still needs to exist as a
 * distinct segment between `\v`s, and an empty one would just vanish.
 */
function codeBlockRuns(code: string): Inline[] {
  const lines = code.split('\n')
  const runs: Inline[] = []
  lines.forEach((line, i) => {
    if (i > 0) runs.push({ kind: 'break' })
    runs.push({ kind: 'text', text: line.length > 0 ? line : ' ' })
  })
  return runs
}

/**
 * Walks one chapter's blocks into a flat TextBlock sequence, plus the bookkeeping compileBlocks needs
 * to style what a plain TextBlock can't express alone: list nesting, rule borders, fenced code, and
 * blockquote insets. Every text block gets non-empty text, since a zero-length paragraph has no valid
 * style range.
 *
 * Tables are captured in the IR (see plan/types.ts) but M3 owns their real formatting; here they
 * degrade to plain paragraphs. Nothing about that degrade path reintroduces markdown syntax — mdast
 * never stores `|` characters in a node's text content, so the residue lint stays clean even for
 * content this milestone doesn't fully render yet.
 */
export function compileBlocks(blocks: Block[]): CompiledBlocks {
  const textBlocks: TextBlock[] = []
  const listRuns: ListRun[] = []
  const ruleIndices: number[] = []
  const codeBlockIndices: number[] = []
  const quoteRuns: QuoteRun[] = []

  function pushPlain(text: string, style: NamedStyleType): void {
    textBlocks.push({ runs: [{ kind: 'text', text }], style })
  }

  function walk(list: Block[], quoteDepth: number): void {
    for (const block of list) {
      switch (block.kind) {
        case 'heading':
          textBlocks.push({ runs: block.children, style: headingStyle(block.level) })
          break

        case 'paragraph':
          textBlocks.push({ runs: block.children, style: 'NORMAL_TEXT' })
          break

        case 'list': {
          const start = textBlocks.length
          for (const item of block.items) {
            const prefix = '\t'.repeat(item.depth)
            textBlocks.push({
              runs: prefix.length > 0 ? [{ kind: 'text', text: prefix }, ...item.children] : item.children,
              style: 'NORMAL_TEXT',
            })
          }
          // createParagraphBullets picks ONE glyph family (decimal/alpha/roman OR
          // disc/circle/square) for its whole range. A list that mixes ordered and unordered
          // markers across depths — numbered top-level steps with unordered sub-bullets, seen live
          // in the real corpus — needs one call per contiguous same-ordered-ness stretch, or the
          // wrong family gets forced onto whichever side lost the vote.
          let groupStart = 0
          for (let i = 1; i <= block.items.length; i++) {
            const atBoundary =
              i === block.items.length || block.items[i]!.ordered !== block.items[groupStart]!.ordered
            if (atBoundary) {
              listRuns.push({
                ordered: block.items[groupStart]!.ordered,
                start: start + groupStart,
                end: start + i,
              })
              groupStart = i
            }
          }
          break
        }

        case 'rule':
          ruleIndices.push(textBlocks.length)
          // A single space: createParagraphBullets aside, every renderable block needs non-empty
          // text, and the border itself does the visual work — the character never shows.
          pushPlain(' ', 'NORMAL_TEXT')
          break

        case 'code-block':
          codeBlockIndices.push(textBlocks.length)
          textBlocks.push({ runs: codeBlockRuns(block.code), style: 'NORMAL_TEXT' })
          break

        case 'table':
          for (const row of block.rows) {
            pushPlain(row.map(cellText).join('   '), 'NORMAL_TEXT')
          }
          break

        case 'blockquote': {
          const start = textBlocks.length
          walk(block.children, quoteDepth + 1)
          if (textBlocks.length > start) {
            quoteRuns.push({ depth: quoteDepth + 1, start, end: textBlocks.length })
          }
          break
        }
      }
    }
  }

  walk(blocks, 0)
  return { textBlocks, listRuns, ruleIndices, codeBlockIndices, quoteRuns }
}

/**
 * Paragraph borders cannot be partially updated, so the full ParagraphBorder is always supplied.
 * Uses the block's own pre-shrink range: safe because nothing that changes document length (bullets)
 * has run yet when this is applied — see the phase ordering in emit/document.ts.
 */
export function ruleStyleRequest(range: docs_v1.Schema$Range, theme: Theme): docs_v1.Schema$Request {
  const border: docs_v1.Schema$ParagraphBorder = {
    color: optionalColor(theme.rule.color),
    width: pt(theme.rule.widthPt),
    padding: pt(2),
    dashStyle: 'SOLID',
  }
  return {
    updateParagraphStyle: {
      range,
      paragraphStyle: {
        borderBottom: border,
        spaceAbove: pt(theme.rule.spaceAbovePt),
        spaceBelow: pt(theme.rule.spaceBelowPt),
      },
      fields: 'border_bottom,space_above,space_below',
    },
  }
}

/**
 * The paragraph carries the shading/border/spacing/keepLinesTogether (one call covers every \v-joined
 * line at once); a second request sets the monospace font/size/colour across the same range. No
 * per-run backgroundColor here — the paragraph shading already does that job, and stacking both would
 * look like a chip floating inside its own block.
 *
 * indentStart/indentEnd are pinned to 0, overriding the narrower prose measure every named style
 * inherits: a code block is meant to run the full page width. Never rely on that inheritance not
 * applying here — CLAUDE.md's rule about setting every block's style explicitly cuts both ways.
 */
export function codeBlockStyleRequests(
  range: docs_v1.Schema$Range,
  theme: Theme,
): docs_v1.Schema$Request[] {
  const spec = theme.codeBlock
  const border: docs_v1.Schema$ParagraphBorder = {
    color: optionalColor(spec.borderColor),
    width: pt(spec.borderWidthPt),
    padding: pt(spec.paddingPt),
    dashStyle: 'SOLID',
  }
  const paragraphRequest: docs_v1.Schema$Request = {
    updateParagraphStyle: {
      range,
      paragraphStyle: {
        shading: { backgroundColor: optionalColor(spec.shading) },
        borderTop: border,
        borderBottom: border,
        borderLeft: border,
        borderRight: border,
        indentStart: pt(0),
        indentEnd: pt(0),
        spaceAbove: pt(spec.spaceAbovePt),
        spaceBelow: pt(spec.spaceBelowPt),
        keepLinesTogether: true,
      },
      fields:
        'shading,border_top,border_bottom,border_left,border_right,indent_start,indent_end,' +
        'space_above,space_below,keep_lines_together',
    },
  }

  const text = textStyleFor(spec.text)
  const textRequest: docs_v1.Schema$Request = {
    updateTextStyle: {
      range,
      textStyle: text.style,
      fields: text.fields.join(','),
    },
  }

  return [paragraphRequest, textRequest]
}

/**
 * A left accent bar plus an inset, scaled by nesting depth for `>>` inside `>`. Applied to the whole
 * spanned range in one call — updateParagraphStyle accepts a multi-paragraph range and styles every
 * paragraph it touches, which is both fewer requests and the only way nested quotes compose: the
 * outer blockquote's call covers the nested content too, and the inner call (issued after, at a
 * greater depth) overrides just its own sub-range to the deeper indent.
 */
export function quoteStyleRequest(
  ranges: docs_v1.Schema$Range[],
  run: QuoteRun,
  theme: Theme,
): docs_v1.Schema$Request {
  const first = ranges[run.start]
  const last = ranges[run.end - 1]
  if (!first || !last) throw new Error(`QuoteRun [${run.start}, ${run.end}) is out of range`)
  const range: docs_v1.Schema$Range = { startIndex: first.startIndex, endIndex: last.endIndex }
  if (first.tabId !== undefined) range.tabId = first.tabId

  // Not indentStart — Docs' PDF export ignores it entirely (verified live; see the note on
  // BlockquoteSpec). A thicker, more padded bar per level is what's actually provable on the page.
  const spec = theme.blockquote
  const border: docs_v1.Schema$ParagraphBorder = {
    color: optionalColor(spec.borderColor),
    width: pt(spec.borderWidthPt + (run.depth - 1)),
    padding: pt(spec.paddingPt + (run.depth - 1) * 4),
    dashStyle: 'SOLID',
  }
  return {
    updateParagraphStyle: {
      range,
      paragraphStyle: { borderLeft: border },
      fields: 'border_left',
    },
  }
}
