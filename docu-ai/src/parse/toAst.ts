import { remark } from 'remark'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'

/**
 * The only function in parse/. It must never mention Google: this module's whole job is producing
 * mdast, nothing else. remark-gfm buys tables, strikethrough, autolinks, and task lists for free.
 *
 * remark-frontmatter is not optional politeness. Without it a leading YAML block does not merely
 * survive as stray text — CommonMark reads the closing `---` as a setext underline, so the whole
 * metadata block becomes an **H2 heading**, complete with a headingId and a place in the document
 * structure. Verified against a real meet-ai transcript (2026-09-20): a 2-hour meeting parsed as
 * thematicBreak + heading(depth 2) + the real H1. planBlock already drops `yaml` nodes, so making
 * the parser emit one is the entire fix.
 */
export function parseMarkdown(source: string): Root {
  const processor = remark().use(remarkGfm).use(remarkFrontmatter)
  return processor.parse(source)
}
