import type { docs_v1 } from 'googleapis'
import type { Block, CodeToken, ImageBlock, Inline, TableBlock } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import type { ImageResolution } from './image.js'
import { textStyleFor, type NamedStyleType } from './namedStyles.js'
import type { TextBlock } from './text.js'
import type { ListRun } from './lists.js'
import { pt, optionalColor } from './units.js'

/** A contiguous run of TextBlocks produced from inside one `>` blockquote, however deeply nested. */
export interface QuoteRun {
  depth: number
  start: number
  end: number
}

/**
 * A run of ordinary blocks (headings, paragraphs, lists, rules, code, quotes) — everything that can
 * still be inserted as one plain-text blob and styled from cursor arithmetic alone, with no readback
 * needed. Bookkeeping here is LOCAL to this segment's own textBlocks/ranges, not the whole document:
 * once a table splits the flow, a fresh segment starts numbering from 0 again.
 */
export interface TextSegment {
  kind: 'text'
  textBlocks: TextBlock[]
  listRuns: ListRun[]
  /** Indices into textBlocks/ranges of a `{kind: 'rule'}` block's placeholder paragraph. */
  ruleIndices: number[]
  /** Indices into textBlocks/ranges of a fenced code block's single, \v-joined paragraph. */
  codeBlockIndices: number[]
  quoteRuns: QuoteRun[]
}

/**
 * A table can't be represented as inserted text with a length known ahead of time (see
 * emit/table.ts), so it splits the document into segments: whatever came before it, the table
 * itself, whatever comes after. This is why M3 is the milestone that finally needs a real readback
 * between insert and style — every earlier milestone fit inside one insert pass.
 */
export interface TableSegment {
  kind: 'table'
  table: TableBlock
}

/**
 * An embeddable image, split into its own segment for the same reason a table is: it can't be
 * inserted as part of one plain-text blob (insertInlineImage is its own request type, not
 * insertText). Only ever constructed for an image compileBlocks has already confirmed is
 * embeddable — a non-embeddable image never reaches this far; it degrades to a plain paragraph of
 * its own alt text instead, inline in whatever TextSegment already held it. naturalWidth/Height are
 * resolved once, by document.ts's own I/O pass, before compileBlocks runs at all.
 */
export interface ImageSegment {
  kind: 'image'
  image: ImageBlock
  naturalWidth: number
  naturalHeight: number
}

export type Segment = TextSegment | TableSegment | ImageSegment

function emptyTextSegment(): TextSegment {
  return { kind: 'text', textBlocks: [], listRuns: [], ruleIndices: [], codeBlockIndices: [], quoteRuns: [] }
}

function headingStyle(level: 1 | 2 | 3 | 4 | 5 | 6): NamedStyleType {
  // Levels 4–6 are valid Docs styles but the technical preset only redefines 1–3 (the fixture corpus
  // never nests past H3); Docs' own default look applies to anything deeper rather than erroring.
  return `HEADING_${level}` as NamedStyleType
}

/**
 * Groups `code` (or, if tokenized, each token's text) into one array of pieces per source line —
 * the shared shape codeBlockRuns needs regardless of whether it's building plain or coloured runs.
 * A token's own text can itself span multiple lines (a multi-line string or comment, say), so a
 * `\n` found INSIDE one token's text is just as much a line boundary as the ones between tokens;
 * this is what lets a single highlight.js token correctly split across several code-block lines
 * without losing its kind.
 */
function tokenPieces(code: string, tokens: CodeToken[] | undefined): CodeToken[][] {
  const source = tokens ?? [{ kind: undefined, text: code }]
  const lines: CodeToken[][] = [[]]
  for (const token of source) {
    token.text.split('\n').forEach((text, i) => {
      if (i > 0) lines.push([])
      lines[lines.length - 1]!.push({ kind: token.kind, text })
    })
  }
  return lines
}

/**
 * A fenced code block as ONE paragraph: each source line becomes one or more runs, joined by
 * `{kind: 'break'}` — the same inline node markdown hard breaks use, which emit/inline.ts turns into
 * a literal `\v`. One paragraph means one shading/border/spacing application covers the whole block
 * with no per-line gaps, and `keepLinesTogether` (applied in codeBlockStyleRequest) has something
 * meaningful to hold together. A blank source line becomes a single space: every line still needs to
 * exist as a distinct segment between `\v`s, and an empty one would just vanish — flattenInline drops
 * any zero-length run, tokenized or not.
 *
 * Without `tokens`, this produces exactly the plain `{kind: 'text'}` sequence it always has — a code
 * block whose language wasn't tokenized (untagged fence, or a language lowlight doesn't register)
 * must emit byte-identically to before this feature existed.
 */
function codeBlockRuns(code: string, tokens?: CodeToken[]): Inline[] {
  const runs: Inline[] = []
  tokenPieces(code, tokens).forEach((pieces, i) => {
    if (i > 0) runs.push({ kind: 'break' })
    const nonEmpty = pieces.filter((p) => p.text.length > 0)
    if (nonEmpty.length === 0) {
      runs.push({ kind: 'text', text: ' ' })
    } else {
      for (const p of nonEmpty) {
        runs.push(tokens === undefined ? { kind: 'text', text: p.text } : { kind: 'codeToken', syntaxKind: p.kind, text: p.text })
      }
    }
  })
  return runs
}

/**
 * Walks one chapter's blocks into an ordered sequence of segments — runs of plain TextBlocks split
 * apart wherever a table appears — plus, within each text segment, the bookkeeping a plain TextBlock
 * can't express alone: list nesting, rule borders, fenced code, and blockquote insets. Every text
 * block gets non-empty text, since a zero-length paragraph has no valid style range.
 *
 * A table gets its own segment rather than degrading to text: see emit/table.ts and TableSegment's
 * doc comment for why it needs a different insert/style path entirely. An image does too, but only
 * when `imageResolutions` says it's actually embeddable — otherwise it degrades to its own alt text
 * as an ordinary paragraph, no different from an image mixed into prose elsewhere in the same
 * document (see plan/fromAst.ts's planParagraph for why that case never even reaches here as an
 * ImageBlock in the first place).
 */
export function compileBlocks(blocks: Block[], imageResolutions: Map<string, ImageResolution>): Segment[] {
  const segments: Segment[] = []
  let current = emptyTextSegment()

  function flush(): void {
    if (current.textBlocks.length > 0) segments.push(current)
    current = emptyTextSegment()
  }

  function pushPlain(text: string, style: NamedStyleType): void {
    current.textBlocks.push({ runs: [{ kind: 'text', text }], style })
  }

  function walk(list: Block[], quoteDepth: number): void {
    for (const block of list) {
      switch (block.kind) {
        case 'heading':
          current.textBlocks.push({ runs: block.children, style: headingStyle(block.level) })
          break

        case 'paragraph':
          current.textBlocks.push({ runs: block.children, style: 'NORMAL_TEXT' })
          break

        case 'list': {
          const start = current.textBlocks.length
          for (const item of block.items) {
            const prefix = '\t'.repeat(item.depth)
            current.textBlocks.push({
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
              current.listRuns.push({
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
          current.ruleIndices.push(current.textBlocks.length)
          // A single space: createParagraphBullets aside, every renderable block needs non-empty
          // text, and the border itself does the visual work — the character never shows.
          pushPlain(' ', 'NORMAL_TEXT')
          break

        case 'code-block':
          current.codeBlockIndices.push(current.textBlocks.length)
          current.textBlocks.push({ runs: codeBlockRuns(block.code, block.tokens), style: 'NORMAL_TEXT' })
          break

        case 'table':
          flush()
          segments.push({ kind: 'table', table: block })
          break

        case 'image': {
          const resolution = imageResolutions.get(block.src)
          if (resolution?.embeddable) {
            flush()
            segments.push({
              kind: 'image',
              image: block,
              naturalWidth: resolution.width,
              naturalHeight: resolution.height,
            })
          } else {
            // Not embeddable — the exact same fallback an image mixed into prose already gets via
            // planInline's own default case: its alt text, as an ordinary paragraph. No flush: this
            // stays part of whatever TextSegment is already open.
            pushPlain(block.alt.length > 0 ? block.alt : ' ', 'NORMAL_TEXT')
          }
          break
        }

        case 'blockquote': {
          const start = current.textBlocks.length
          walk(block.children, quoteDepth + 1)
          // A table inside the quote already flushed `current`, ending this run early — rare (no
          // GFM corpus does this) and visually reasonable anyway: a table can't carry a left border
          // the way a paragraph can, so the bar breaking around it is the honest outcome.
          if (current.textBlocks.length > start) {
            current.quoteRuns.push({ depth: quoteDepth + 1, start, end: current.textBlocks.length })
          }
          break
        }
      }
    }
  }

  walk(blocks, 0)
  flush()
  return segments
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
 *
 * `highlighted` must be true when this block's own runs already carry per-token foreground colours
 * (see emit/text.ts's renderTextBlocks). Confirmed live: this block-wide text request is issued
 * AFTER those per-run requests in compile.ts, so a block-wide `foreground_color` here would silently
 * overwrite every token's own colour with the base text colour — same field, later request wins,
 * with no error from either request. Dropping `foreground_color` from THIS request's mask when
 * `highlighted` is the fix, not reordering: no ordering dependency to get wrong again later.
 *
 * Known, deliberate cosmetic gap this creates: a highlighted block's own unclassified characters
 * (punctuation, whitespace between tokens — anything highlight.js didn't tag, or a tag not in
 * theme/'s syntax palette) get NO foreground colour at all rather than the theme's base grey, since
 * dropping the field means dropping it everywhere in the range, not just where a token overrides it.
 * They render in Docs' own default text colour, which for this theme (#202124, very dark grey) is
 * visually indistinguishable from true black at reading size. Fixing it precisely would mean
 * reordering (base colour first, token colours after) scoped to exactly this one block — real, if
 * modest, complexity for a difference no reader will notice. Left as-is on purpose.
 */
export function codeBlockStyleRequests(
  range: docs_v1.Schema$Range,
  theme: Theme,
  highlighted = false,
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
  const textStyle = { ...text.style }
  let textFields = text.fields
  if (highlighted) {
    delete textStyle.foregroundColor
    textFields = textFields.filter((f) => f !== 'foreground_color')
  }
  const textRequest: docs_v1.Schema$Request = {
    updateTextStyle: {
      range,
      textStyle,
      fields: textFields.join(','),
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
