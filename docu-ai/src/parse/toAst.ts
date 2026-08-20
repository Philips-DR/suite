import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'

/**
 * The only function in parse/. It must never mention Google: this module's whole job is producing
 * mdast, nothing else. remark-gfm buys tables, strikethrough, autolinks, and task lists for free.
 */
export function parseMarkdown(source: string): Root {
  const processor = remark().use(remarkGfm)
  return processor.parse(source)
}
