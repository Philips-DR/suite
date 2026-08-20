/**
 * DocPlan — semantic, not visual. A heading is `{kind: 'heading', level: 2, ...}`, never a font size.
 * plan/ must never mention fonts, colours, or indices; those belong to theme/ and emit/.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string } // an inline code span, e.g. `like this`
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'italic'; children: Inline[] }
  | { kind: 'strikethrough'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' } // an explicit hard line break, inside one paragraph

export interface HeadingBlock {
  kind: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  children: Inline[]
}

export interface ParagraphBlock {
  kind: 'paragraph'
  children: Inline[]
}

export interface ListItem {
  /** 0 = top level. Depth comes from mdast's list-within-listItem nesting, not indentation counting. */
  depth: number
  ordered: boolean
  children: Inline[]
}

export interface ListBlock {
  kind: 'list'
  items: ListItem[]
}

export interface RuleBlock {
  kind: 'rule'
}

/**
 * Real fenced-code and table formatting are M2 and M3. The kind is captured now so nothing is lost
 * on the way through parse — emit/ decides per-milestone how much of it to honour.
 */
export interface CodeBlockNode {
  kind: 'code-block'
  lang: string | undefined
  code: string
}

export interface TableBlock {
  kind: 'table'
  align: Array<'left' | 'center' | 'right' | undefined>
  /** rows -> cells -> inline content. rows[0] is always the header — GFM tables require exactly one. */
  rows: Inline[][][]
}

/** Real quote styling is M2. Content is preserved as ordinary blocks until then. */
export interface BlockquoteBlock {
  kind: 'blockquote'
  children: Block[]
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | RuleBlock
  | CodeBlockNode
  | TableBlock
  | BlockquoteBlock

export interface Chapter {
  title: string
  blocks: Block[]
}

export interface DocPlan {
  title: string
  chapters: Chapter[]
}

/** A convenience constructor for the common case of an unstyled run of text. */
export function plain(text: string): Inline[] {
  return [{ kind: 'text', text }]
}
