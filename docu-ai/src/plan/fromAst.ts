import { toString as mdastToString } from 'mdast-util-to-string'
import type {
  Blockquote,
  Content,
  Heading,
  List as MdastList,
  Paragraph,
  PhrasingContent,
  Root,
  Table as MdastTable,
} from 'mdast'
import type { Block, CodeBlockNode, Chapter, DocPlan, ImageBlock, Inline, ListItem } from './types.js'
import { detectLanguage } from './languageDetect.js'
import { highlightCode } from './syntaxHighlight.js'
import { collapseSoftWraps, typeset } from './typography.js'

/** Inline marks flatten recursively; typography applies only at the plain-text leaves. */
function planInline(nodes: PhrasingContent[]): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ kind: 'text', text: typeset(node.value) })
        break
      case 'inlineCode':
        // Never typeset (quotes/dashes must survive byte-for-byte), but a code span that spans a
        // source line break is a real case in the corpus (verified against a live parse: remark
        // keeps the raw "\n" plus the next line's indentation in node.value). CommonMark specifies a
        // line ending inside a code span becomes a single space, so this is normalization the parser
        // itself doesn't do, not typesetting — collapseSoftWraps happens to be exactly that rule.
        out.push({ kind: 'code', text: collapseSoftWraps(node.value) })
        break
      case 'strong':
        out.push({ kind: 'bold', children: planInline(node.children) })
        break
      case 'emphasis':
        out.push({ kind: 'italic', children: planInline(node.children) })
        break
      case 'delete':
        out.push({ kind: 'strikethrough', children: planInline(node.children) })
        break
      case 'link':
        out.push({ kind: 'link', href: node.url, children: planInline(node.children) })
        break
      case 'break':
        out.push({ kind: 'break' })
        break
      default:
        // html, image, footnoteReference, etc. — not in the fixture corpus; fall back to plain text
        // rather than dropping content silently.
        out.push({ kind: 'text', text: typeset(mdastToString(node)) })
    }
  }
  return out
}

function paragraphChildren(node: { children: Content[] }): Inline[] {
  const paragraphs = node.children.filter((c): c is Paragraph => c.type === 'paragraph')
  return planInline(paragraphs.flatMap((p) => p.children))
}

/**
 * A list's items may each contain a nested `list` alongside their own paragraph — mdast has already
 * resolved the nesting structurally, so depth comes from recursion, never from counting leading
 * whitespace in source text.
 */
function flattenList(list: MdastList, depth: number): ListItem[] {
  const items: ListItem[] = []
  for (const item of list.children) {
    items.push({ depth, ordered: list.ordered ?? false, children: paragraphChildren(item) })
    for (const child of item.children) {
      if (child.type === 'list') items.push(...flattenList(child, depth + 1))
    }
  }
  return items
}

function planTable(node: MdastTable): Block {
  return {
    kind: 'table',
    align: (node.align ?? []).map((a) => a ?? undefined),
    rows: node.children.map((row) => row.children.map((cell) => planInline(cell.children))),
  }
}

function planBlockquote(node: Blockquote): Block {
  return { kind: 'blockquote', children: node.children.map(planBlock).filter((b): b is Block => b !== undefined) }
}

/**
 * mdast has no "block image" node — `![alt](src)` is a phrasing node like any other, always nested
 * in a paragraph, whether it sits alone on its own line or mixed with other text (verified directly:
 * both produce the identical AST shape). So a real embedded image is only ever the special case of a
 * paragraph whose sole child is that one image node; anything else — image mixed with prose, or html/
 * footnoteReference/etc. mixed in — falls through to the ordinary paragraph path, where planInline's
 * existing unknown-node fallback already renders an image as its own alt text. That fallback isn't
 * new code for this feature; it already existed and already does the right thing.
 */
function planParagraph(node: Paragraph): Block {
  const onlyChild = node.children.length === 1 ? node.children[0] : undefined
  if (onlyChild?.type === 'image') {
    return imageBlock(onlyChild)
  }
  return { kind: 'paragraph', children: planInline(node.children) }
}

function imageBlock(node: { url: string; alt?: string | null; title?: string | null }): ImageBlock {
  return {
    kind: 'image',
    src: node.url,
    alt: typeset(node.alt ?? ''),
    title: node.title != null ? typeset(node.title) : undefined,
  }
}

/**
 * Never typesets `code` (byte-for-byte, same rule as an inline code span) and never guesses a
 * language just to get a highlight: `lang` is already either an explicit fence tag or
 * detectLanguage's own considered "or nothing" answer. Tokenizing only when `lang` is defined is
 * what keeps an untagged ASCII diagram from ever reaching highlightCode at all — see
 * languageDetect.ts's finding that every untagged fence in the real corpus was exactly that, not code.
 */
function planCodeBlock(lang: string | undefined, code: string): CodeBlockNode {
  const tokens = lang !== undefined ? highlightCode(lang, code) : undefined
  return tokens ? { kind: 'code-block', lang, code, tokens } : { kind: 'code-block', lang, code }
}

function planBlock(node: Content): Block | undefined {
  switch (node.type) {
    case 'heading':
      return { kind: 'heading', level: node.depth, children: planInline(node.children) }
    case 'paragraph':
      return planParagraph(node)
    case 'list':
      return { kind: 'list', items: flattenList(node, 0) }
    case 'thematicBreak':
      return { kind: 'rule' }
    case 'code':
      return planCodeBlock(node.lang ?? detectLanguage(node.value), node.value)
    case 'table':
      return planTable(node)
    case 'blockquote':
      return planBlockquote(node)
    default:
      // yaml frontmatter, html, definitions — none present in the target corpus (see
      // test/fixtures/README.md); skipped rather than guessed at.
      return undefined
  }
}

function chapterTitle(ast: Root, fallback: string): string {
  const firstHeading = ast.children.find((c): c is Heading => c.type === 'heading' && c.depth === 1)
  return firstHeading ? mdastToString(firstHeading).trim() || fallback : fallback
}

export function planChapter(ast: Root, fallbackTitle: string, sourceFile: string): Chapter {
  return {
    title: chapterTitle(ast, fallbackTitle),
    sourceFile,
    blocks: ast.children.map(planBlock).filter((b): b is Block => b !== undefined),
  }
}

/** A markdown link's href as an author would write it when linking to a sibling chapter file:
 * strips a leading "./" and a trailing "#fragment"/"?query", but nothing fancier — chapters are
 * always siblings in one flat folder (see parse/loadDir.ts), never nested paths. */
function normaliseChapterHref(href: string): string {
  return href.replace(/^\.\//, '').replace(/[?#].*$/, '')
}

function resolveInline(node: Inline, chapterByFile: Map<string, number>): Inline {
  switch (node.kind) {
    case 'text':
    case 'code':
    case 'break':
    case 'codeToken':
      // codeToken is synthesized later, in emit/blocks.ts, from a code-block's own `tokens` — it
      // never exists at this point in the pipeline. Handled only so this switch stays exhaustive.
      return node
    case 'bold':
    case 'italic':
    case 'strikethrough':
      return { ...node, children: node.children.map((c) => resolveInline(c, chapterByFile)) }
    case 'link': {
      const children = node.children.map((c) => resolveInline(c, chapterByFile))
      const chapterIndex = chapterByFile.get(normaliseChapterHref(node.href))
      return chapterIndex === undefined ? { ...node, children } : { kind: 'chapterLink', chapterIndex, children }
    }
    case 'chapterLink':
      // planInline() never produces this itself — only this resolution pass does, and it runs once
      // over freshly-parsed chapters. Handled only so this switch stays exhaustive over Inline.
      return node
  }
}

function resolveBlockLinks(block: Block, chapterByFile: Map<string, number>): Block {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
      return { ...block, children: block.children.map((c) => resolveInline(c, chapterByFile)) }
    case 'list':
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          children: item.children.map((c) => resolveInline(c, chapterByFile)),
        })),
      }
    case 'table':
      return {
        ...block,
        rows: block.rows.map((row) => row.map((cell) => cell.map((c) => resolveInline(c, chapterByFile)))),
      }
    case 'blockquote':
      return { ...block, children: block.children.map((c) => resolveBlockLinks(c, chapterByFile)) }
    case 'rule':
    case 'code-block':
    case 'image':
      // An image carries no Inline children to resolve — src/alt/title are plain strings, and a
      // sole-image paragraph never itself IS a link (see planParagraph).
      return block
  }
}

/**
 * Assembles the final DocPlan and, in the same pass, resolves any inline link whose href names
 * another chapter in this same build into a chapterLink — this can only happen here, once every
 * chapter's sourceFile is known, never inside planChapter which only ever sees one file at a time.
 */
export function planDocument(chapters: Chapter[], title: string): DocPlan {
  const chapterByFile = new Map(chapters.map((c, i) => [c.sourceFile, i]))
  const resolved = chapters.map((chapter) => ({
    ...chapter,
    blocks: chapter.blocks.map((block) => resolveBlockLinks(block, chapterByFile)),
  }))
  return { title, chapters: resolved }
}
