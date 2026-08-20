/**
 * A theme is the single place in this codebase where a font, colour, size, or spacing value may
 * appear. Nothing in parse/, plan/, or emit/ is allowed to know these numbers.
 */

/** `#rgb` or `#rrggbb`. */
export type Hex = string

export interface TextSpec {
  font: string
  sizePt: number
  bold?: boolean
  italic?: boolean
  color?: Hex
  /** Multiple of 100, 100–900. Combines with `bold`; see WeightedFontFamily in the Docs API. */
  weight?: number
  backgroundColor?: Hex
}

export interface RuleSpec {
  color: Hex
  widthPt: number
  spaceAbovePt: number
  spaceBelowPt: number
}

export interface ParaSpec {
  spaceAbovePt?: number
  spaceBelowPt?: number
  /** Percentage, where 100 is single spacing. */
  lineSpacingPct?: number
  /** Keeps a heading on the same page as the text it introduces. */
  keepWithNext?: boolean
  alignment?: 'START' | 'CENTER' | 'END' | 'JUSTIFIED'
  /** Page-margin-relative inset. Prose narrows to a comfortable measure; code blocks stay full width. */
  indentStartPt?: number
  indentEndPt?: number
}

export interface BlockSpec {
  text: TextSpec
  para: ParaSpec
}

export interface PageSpec {
  marginTopPt: number
  marginBottomPt: number
  marginLeftPt: number
  marginRightPt: number
}

/**
 * A fenced code block is rendered as ONE paragraph (lines joined by a hard `\v` break, not separate
 * paragraphs), so a single shading + border + spacing here covers the whole block with no per-line
 * gaps. `paddingPt` is the border-to-text gap (ParagraphBorder.padding); the block itself spans full
 * width — no indentStart/End — while prose narrows around it (see Theme.body and friends).
 */
export interface CodeBlockSpec {
  text: TextSpec
  shading: Hex
  borderColor: Hex
  borderWidthPt: number
  paddingPt: number
  spaceAbovePt: number
  spaceBelowPt: number
}

/**
 * A left accent bar plus an inset, scaled by nesting depth for `>>` inside `>`.
 *
 * NOT indentStart: verified live (2026-08-19, five separate documents) that Docs' PDF export
 * completely ignores ParagraphStyle.indentStart — stored and read back correctly via documents.get,
 * at any magnitude up to 200pt, set via a named style or a per-paragraph override, with or without a
 * border on the same paragraph, but the exported text never moves. indentEnd has no such problem
 * (proven by the narrower prose column every named style already uses). See CLAUDE.md.
 *
 * So nesting depth is expressed the only way here that's proven to render: a thicker, more padded
 * border bar per level, not a rightward step. See emit/blocks.ts's quoteStyleRequest.
 */
export interface BlockquoteSpec {
  borderColor: Hex
  borderWidthPt: number
  paddingPt: number
}

/**
 * Docs' own default cell borders (confirmed live: a plain `insertTable` already renders clean, thin
 * black grid lines with no styling request at all) are left alone — only what a careful human would
 * actually add on top gets a spec here: a shaded, bold header row. Column widths are deliberately
 * NOT themed: the real corpus's tables are narrow (2–4 columns) and Docs' own default
 * (EVENLY_DISTRIBUTED) was judged fine after looking at the live render — see plan.md.
 */
export interface TableSpec {
  headerShading: Hex
}

/**
 * Only the blocks M0–M2 needed. The IR is expected to keep growing with each milestone — that's not
 * a design failure.
 */
export interface Theme {
  name: string
  page: PageSpec
  title: BlockSpec
  subtitle: BlockSpec
  heading1: BlockSpec
  heading2: BlockSpec
  heading3: BlockSpec
  body: BlockSpec
  /** Inline code spans (`like this`). */
  code: TextSpec
  rule: RuleSpec
  codeBlock: CodeBlockSpec
  blockquote: BlockquoteSpec
  table: TableSpec
}

export function themeFonts(theme: Theme): string[] {
  const blocks = [
    theme.title,
    theme.subtitle,
    theme.heading1,
    theme.heading2,
    theme.heading3,
    theme.body,
  ]
  return [
    ...new Set([...blocks.map((b) => b.text.font), theme.code.font, theme.codeBlock.text.font]),
  ]
}
