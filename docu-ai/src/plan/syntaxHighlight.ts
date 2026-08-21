import { createLowlight, all } from 'lowlight'
import type { Element, RootContent } from 'hast'
import type { CodeToken } from './types.js'

/**
 * highlight.js via lowlight, registered against `all` (192 grammars, including `dockerfile` — the
 * smaller `common` set of 37 does not have it). Sync, unlike Shiki, which loads grammars
 * asynchronously and would force planChapter (and everything above it) to become async for a
 * cosmetic feature. Lowlight also emits ~20 stable, documented class names rather than baked
 * colours, which is what lets theme/ own the actual palette (see CodeBlockSpec.syntax) instead of
 * importing a colour scheme that theme/ doesn't control.
 */
const lowlight = createLowlight(all)

/**
 * Tokenizes `code` for `lang`, or returns undefined if `lang` isn't a registered grammar — never
 * guesses, mirroring languageDetect.ts's own "return undefined rather than guess" rule. Callers
 * should only call this for a `lang` that's non-empty (an untagged fence has no business being
 * tokenized at all — see that module's own finding that every untagged fence in the real corpus
 * turned out to be an ASCII diagram, not code).
 */
export function highlightCode(lang: string, code: string): CodeToken[] | undefined {
  if (!lowlight.registered(lang)) return undefined

  const tokens: CodeToken[] = []
  walkChildren(lowlight.highlight(lang, code).children, undefined)
  return tokens

  function walkChildren(children: RootContent[], kind: string | undefined): void {
    for (const child of children) {
      if (child.type === 'text') {
        if (child.value.length > 0) tokens.push({ kind, text: child.value })
      } else if (child.type === 'element') {
        walkChildren(child.children, tokenKind(child) ?? kind)
      }
      // 'comment' and 'doctype' never appear in highlight.js output — deliberately unhandled.
    }
  }
}

/**
 * A span can carry more than one class — YAML's document-marker span is "hljs-variable language_",
 * for instance — so the first `hljs-`-prefixed class wins and the rest are ignored. A span with no
 * `hljs-*` class (shouldn't happen, but isn't assumed) keeps its parent's kind rather than resetting
 * to plain, so nesting a plain <span> inside a token never blanks that token's colour.
 */
function tokenKind(element: Element): string | undefined {
  const hljsClass = (element.properties.className ?? []).find((c) => c.startsWith('hljs-'))
  return hljsClass?.slice('hljs-'.length)
}
