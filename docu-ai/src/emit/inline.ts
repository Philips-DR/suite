import type { Inline } from '../plan/types.js'

export type Mark = 'bold' | 'italic' | 'strikethrough' | 'code'

/**
 * One contiguous span of text sharing exactly one set of marks and one link target. Pure: no theme,
 * no indices. Converting marks + href into TextStyle requests is emit/text.ts's job, once it knows
 * where each run actually landed.
 */
export interface FlatRun {
  text: string
  marks: Mark[]
  href: string | undefined
}

function styleKey(marks: Mark[], href: string | undefined): string {
  return `${[...marks].sort().join(',')}|${href ?? ''}`
}

function walk(nodes: Inline[], marks: Mark[], href: string | undefined, out: FlatRun[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        if (node.text.length > 0) out.push({ text: node.text, marks, href })
        break
      case 'code':
        // Inline code content is never typeset (see plan/typography.ts) and always carries 'code'.
        if (node.text.length > 0) out.push({ text: node.text, marks: [...marks, 'code'], href })
        break
      case 'break':
        // A hard line break inside one paragraph. Google Docs uses \v for this — see CLAUDE.md.
        out.push({ text: '\v', marks, href })
        break
      case 'bold':
        walk(node.children, [...marks, 'bold'], href, out)
        break
      case 'italic':
        walk(node.children, [...marks, 'italic'], href, out)
        break
      case 'strikethrough':
        walk(node.children, [...marks, 'strikethrough'], href, out)
        break
      case 'link':
        // A link nested inside a link is not valid markdown; the inner href simply wins.
        walk(node.children, marks, node.href, out)
        break
    }
  }
}

/** Flattens nested marks into a run sequence, merging adjacent runs that share the same styling. */
export function flattenInline(nodes: Inline[]): FlatRun[] {
  const raw: FlatRun[] = []
  walk(nodes, [], undefined, raw)

  const merged: FlatRun[] = []
  for (const run of raw) {
    const prev = merged[merged.length - 1]
    if (prev && styleKey(prev.marks, prev.href) === styleKey(run.marks, run.href)) {
      prev.text += run.text
    } else {
      merged.push({ ...run })
    }
  }
  return merged
}

/** The plain text a run sequence would insert — no marks, no links, just characters. */
export function plainText(runs: FlatRun[]): string {
  return runs.map((r) => r.text).join('')
}
