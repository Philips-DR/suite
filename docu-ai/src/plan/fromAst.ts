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
import type { Block, Chapter, DocPlan, Inline, ListItem } from './types.js'
import { detectLanguage } from './languageDetect.js'
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

function planBlock(node: Content): Block | undefined {
  switch (node.type) {
    case 'heading':
      return { kind: 'heading', level: node.depth, children: planInline(node.children) }
    case 'paragraph':
      return { kind: 'paragraph', children: planInline(node.children) }
    case 'list':
      return { kind: 'list', items: flattenList(node, 0) }
    case 'thematicBreak':
      return { kind: 'rule' }
    case 'code':
      return { kind: 'code-block', lang: node.lang ?? detectLanguage(node.value), code: node.value }
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

export function planChapter(ast: Root, fallbackTitle: string): Chapter {
  return {
    title: chapterTitle(ast, fallbackTitle),
    blocks: ast.children.map(planBlock).filter((b): b is Block => b !== undefined),
  }
}

export function planDocument(chapters: Chapter[], title: string): DocPlan {
  return { title, chapters }
}
