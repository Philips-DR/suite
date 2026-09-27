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
  // A link whose href resolved (in planDocument, once every chapter's filename is known) to another
  // chapter in this same build, rather than a real external URL. chapterIndex is a plain index into
  // DocPlan.chapters — still semantic, not a Google concept; emit/ is what turns it into a real
  // Link.heading once tab ids and heading ids exist.
  | { kind: 'chapterLink'; chapterIndex: number; children: Inline[] }
  // One highlight.js token from inside a fenced code block (see plan/syntaxHighlight.ts). Distinct
  // from `code` (an inline span in prose): a code-block line already gets its mono font/shading from
  // the whole paragraph, so this carries only the token's semantic kind for theme/ to colour, never
  // the 'code' mark. syntaxKind undefined = unclassified text within an otherwise-tokenized block.
  | { kind: 'codeToken'; syntaxKind: string | undefined; text: string }
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
 * One highlight.js token from tokenizing a fenced block's code (see plan/syntaxHighlight.ts).
 * `kind` is a bare highlight.js class name (`hljs-` prefix stripped) — semantic, not a colour;
 * theme/ decides what, if anything, a given kind renders as. `undefined` means unclassified text
 * within an otherwise-tokenized block (whitespace, punctuation, anything highlight.js didn't tag).
 */
export interface CodeToken {
  kind: string | undefined
  text: string
}

/**
 * Real fenced-code and table formatting are M2 and M3. The kind is captured now so nothing is lost
 * on the way through parse — emit/ decides per-milestone how much of it to honour.
 */
export interface CodeBlockNode {
  kind: 'code-block'
  lang: string | undefined
  code: string
  /** Present only when `lang` is both known and a registered highlight.js grammar. Absent means
   * "render as plain code," never "highlighting failed" — see plan/syntaxHighlight.ts. */
  tokens?: CodeToken[]
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

/**
 * A markdown image (`![alt](src)`) whose paragraph contains nothing else — mdast itself makes no
 * structural distinction between "an image alone on its own line" and "an image mixed with other
 * text" (both are just a paragraph whose children happen to include an image node), so this only
 * exists for the sole-image case; see plan/fromAst.ts's planBlock. A mixed-inline image already
 * degrades gracefully to its alt text via planInline's existing unknown-node fallback — no separate
 * handling needed for that case at all.
 */
export interface ImageBlock {
  kind: 'image'
  src: string
  alt: string
  title: string | undefined
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | RuleBlock
  | CodeBlockNode
  | TableBlock
  | BlockquoteBlock
  | ImageBlock

export interface Chapter {
  title: string
  /** The source file's own name (e.g. "01-api-layer.md") — how a sibling chapter's markdown link
   * refers to it. Used only to resolve cross-chapter links in planDocument; never shown to a reader. */
  sourceFile: string
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
