import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planChapter, planDocument } from '../src/plan/fromAst.js'
import { parseMarkdown } from '../src/parse/toAst.js'
import type { Block, Inline } from '../src/plan/types.js'

function plan(markdown: string) {
  return planChapter(parseMarkdown(markdown), 'fallback', 'fallback.md')
}

describe('planChapter — structure', () => {
  it('takes the chapter title from the first H1, not the fallback', () => {
    expect(plan('# Real Title\n\nbody').title).toBe('Real Title')
  })

  it('falls back when there is no H1', () => {
    expect(plan('## Only an H2').title).toBe('fallback')
  })

  it('keeps the H1 as an ordinary heading block too', () => {
    const { blocks } = plan('# Title\n\nbody')
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 })
  })

  it('records heading level from mdast depth', () => {
    const { blocks } = plan('# a\n\n## b\n\n### c')
    expect(blocks.map((b) => (b as Extract<Block, { kind: 'heading' }>).level)).toEqual([1, 2, 3])
  })
})

describe('planChapter — inline marks', () => {
  it('captures bold, italic, strikethrough, code, and link as distinct nested kinds', () => {
    const { blocks } = plan('**b** *i* ~~s~~ `c` [l](https://x.example)')
    const p = blocks[0] as Extract<Block, { kind: 'paragraph' }>
    const kinds = p.children.filter((n) => n.kind !== 'text').map((n) => n.kind)
    expect(kinds).toEqual(['bold', 'italic', 'strikethrough', 'code', 'link'])
  })

  // Found live: 03-validation-engine-core.md has a code span split across two source lines
  // (`API_VP -->\n   |"run"| X`). remark keeps the raw newline + next-line indentation in
  // inlineCode.value; CommonMark specifies a code-span line ending becomes a single space.
  it('collapses a line break inside a multi-line inline code span to one space', () => {
    const { blocks } = plan('see `API_VP -->\n   |"run"| X`.')
    const p = blocks[0] as Extract<Block, { kind: 'paragraph' }>
    const code = p.children.find((n): n is Extract<Inline, { kind: 'code' }> => n.kind === 'code')
    expect(code?.text).toBe('API_VP --> |"run"| X')
  })

  it('never typesets inline code, unlike surrounding prose', () => {
    const { blocks } = plan(`It's \`don't\` literally.`)
    const p = blocks[0] as Extract<Block, { kind: 'paragraph' }>
    const code = p.children.find((n): n is Extract<Inline, { kind: 'code' }> => n.kind === 'code')
    expect(code?.text).toBe(`don't`) // straight apostrophe preserved, not smartened to ’
    const text = p.children.find((n) => n.kind === 'text')
    expect((text as Extract<Inline, { kind: 'text' }>).text).toContain('’s') // prose IS smartened
  })

  it('collapses a markdown soft wrap into a single space', () => {
    const { blocks } = plan('line one\nline two, same paragraph')
    const p = blocks[0] as Extract<Block, { kind: 'paragraph' }>
    expect((p.children[0] as Extract<Inline, { kind: 'text' }>).text).toBe(
      'line one line two, same paragraph',
    )
  })

  it('represents an explicit hard break as its own inline node, not a paragraph split', () => {
    const { blocks } = plan('line one  \nline two')
    const p = blocks[0] as Extract<Block, { kind: 'paragraph' }>
    expect(p.children.map((n) => n.kind)).toEqual(['text', 'break', 'text'])
    expect(blocks).toHaveLength(1) // one paragraph, not two
  })
})

describe('planChapter — lists', () => {
  it('flattens nested lists using recursion depth, not indentation counting', () => {
    const { blocks } = plan('- top\n  - mid\n    - deep\n- back to top')
    const list = blocks[0] as Extract<Block, { kind: 'list' }>
    expect(list.items.map((i) => i.depth)).toEqual([0, 1, 2, 0])
  })

  it('records ordered vs unordered per item from its own list', () => {
    const { blocks } = plan('1. a\n2. b')
    const list = blocks[0] as Extract<Block, { kind: 'list' }>
    expect(list.items.every((i) => i.ordered)).toBe(true)
  })
})

describe('planChapter — rule, code block, table, blockquote', () => {
  it('captures a thematic break as a rule block', () => {
    expect(plan('above\n\n---\n\nbelow').blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'rule',
      'paragraph',
    ])
  })

  it('preserves fenced code verbatim, with no fence markers in the value', () => {
    const { blocks } = plan('```python\nx = 1\n```')
    const code = blocks[0] as Extract<Block, { kind: 'code-block' }>
    expect(code.kind).toBe('code-block')
    expect(code.lang).toBe('python')
    expect(code.code).toBe('x = 1')
  })

  it('marks an unlabeled fence with lang undefined when detectLanguage finds nothing', () => {
    const { blocks } = plan('```\nx = 1\n```')
    expect((blocks[0] as Extract<Block, { kind: 'code-block' }>).lang).toBeUndefined()
  })

  it('fills in a language via detectLanguage for an unlabeled fence that does match a signature', () => {
    const { blocks } = plan('```\ndef f(x):\n    return x + 1\n```')
    expect((blocks[0] as Extract<Block, { kind: 'code-block' }>).lang).toBe('python')
  })

  it('never overrides an explicit fence language, even if detection would disagree', () => {
    const { blocks } = plan('```text\ndef f(x): return x\n```')
    expect((blocks[0] as Extract<Block, { kind: 'code-block' }>).lang).toBe('text')
  })

  // M7: syntax highlighting. Tokenizing only ever happens once `lang` is already settled (explicit
  // tag or detectLanguage's own considered answer) — never a separate guess of its own.
  it('tokenizes a fenced block whose language is a registered highlight.js grammar', () => {
    const { blocks } = plan('```python\ndef f(x):\n    return x + 1\n```')
    const code = blocks[0] as Extract<Block, { kind: 'code-block' }>
    expect(code.tokens?.some((t) => t.kind === 'keyword' && t.text === 'def')).toBe(true)
    expect(code.tokens?.some((t) => t.kind === 'keyword' && t.text === 'return')).toBe(true)
    expect(code.tokens?.some((t) => t.kind === 'number' && t.text === '1')).toBe(true)
  })

  it('leaves an untagged, undetected fence untokenized rather than guessing a language for it', () => {
    const { blocks } = plan('```\nHTTP client\n   ▼\nFastAPI\n```')
    expect((blocks[0] as Extract<Block, { kind: 'code-block' }>).tokens).toBeUndefined()
  })

  it('leaves a fence tagged with an unregistered language untokenized rather than throwing', () => {
    const { blocks } = plan('```not-a-real-language\nwhatever\n```')
    const code = blocks[0] as Extract<Block, { kind: 'code-block' }>
    expect(code.lang).toBe('not-a-real-language')
    expect(code.tokens).toBeUndefined()
  })

  it('captures table alignment and cell content structurally, never as pipe characters', () => {
    const { blocks } = plan('| L | C |\n|:---|:---:|\n| a | b |')
    const table = blocks[0] as Extract<Block, { kind: 'table' }>
    expect(table.align).toEqual(['left', 'center'])
    expect(table.rows).toHaveLength(2)
    expect((table.rows[1]![0]![0] as Extract<Inline, { kind: 'text' }>).text).toBe('a')
  })

  it('keeps a blockquote as block children, not flattened text', () => {
    const { blocks } = plan('> quoted')
    expect(blocks[0]).toMatchObject({ kind: 'blockquote', children: [{ kind: 'paragraph' }] })
  })
})

// M8: images. mdast has no "block image" node — a standalone `![alt](src)` is a paragraph whose sole
// child is an image, identical in shape to one mixed into prose (verified directly against mdast's
// own output). So the sole-image case gets a real ImageBlock; anything else keeps falling through to
// planInline's pre-existing unknown-node fallback, which already renders an image as its alt text.
describe('planChapter — images', () => {
  it('turns a paragraph containing only an image into an ImageBlock', () => {
    const { blocks } = plan('![A diagram](https://example.com/diagram.png)')
    expect(blocks[0]).toEqual({
      kind: 'image',
      src: 'https://example.com/diagram.png',
      alt: 'A diagram',
      title: undefined,
    })
  })

  it('carries an optional title through', () => {
    const { blocks } = plan('![alt](https://example.com/x.png "A caption")')
    expect((blocks[0] as Extract<Block, { kind: 'image' }>).title).toBe('A caption')
  })

  it('defaults alt to an empty string, never undefined, when the markdown has none', () => {
    const { blocks } = plan('![](https://example.com/x.png)')
    expect((blocks[0] as Extract<Block, { kind: 'image' }>).alt).toBe('')
  })

  it('falls back to alt text for an image mixed with other text in the same paragraph', () => {
    const { blocks } = plan('See the ![diagram](https://example.com/x.png) below.')
    const paragraph = blocks[0] as Extract<Block, { kind: 'paragraph' }>
    expect(paragraph.kind).toBe('paragraph')
    const text = (paragraph.children as Extract<Inline, { kind: 'text' }>[]).map((n) => n.text).join('')
    expect(text).toBe('See the diagram below.')
  })

  it('typesets alt/title the same as any other plain text leaf', () => {
    const { blocks } = plan('![It\'s "quoted"](https://example.com/x.png "It\'s here")')
    const image = blocks[0] as Extract<Block, { kind: 'image' }>
    expect(image.alt).toBe('It’s “quoted”')
    expect(image.title).toBe('It’s here')
  })
})

describe('planChapter — against the real corpus', () => {
  const source = readFileSync('/home/philip/Documents/technical/01-api-layer.md', 'utf8')
  const chapter = plan(source)

  it('extracts the real chapter title from the H1, em dash and all', () => {
    expect(chapter.title).toBe('Chapter 1 — The API Layer')
  })

  it('parses without throwing and produces a non-trivial block sequence', () => {
    expect(chapter.blocks.length).toBeGreaterThan(20)
  })

  it('reaches heading levels 1, 2, and 3, matching the file’s own structure', () => {
    const levels = new Set(
      chapter.blocks.filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading').map((b) => b.level),
    )
    expect(levels).toEqual(new Set([1, 2, 3]))
  })

  it('leaves no raw "\\n" inside any prose text leaf — soft wraps must have collapsed', () => {
    function walk(nodes: Inline[]): string[] {
      return nodes.flatMap((n) =>
        n.kind === 'text' && n.text.includes('\n')
          ? [n.text]
          : 'children' in n
            ? walk(n.children)
            : [],
      )
    }
    const offenders = chapter.blocks.flatMap((b) => {
      if (b.kind === 'heading' || b.kind === 'paragraph') return walk(b.children)
      if (b.kind === 'list') return b.items.flatMap((i) => walk(i.children))
      return []
    })
    expect(offenders).toEqual([])
  })
})

// Found building the full 9-chapter real corpus (2026-08-20): 00-overview.md's own "how this doc is
// organized" table links to sibling chapter files, e.g. [01-api-layer.md](01-api-layer.md). Those
// came through as literal, non-resolving Link.url values (Google coerces a bare relative string into
// "http://01-api-layer.md" rather than rejecting it) — see CLAUDE.md's real-corpus findings.
describe('planDocument — cross-chapter link resolution', () => {
  it('resolves a link to a sibling chapter’s own file into a chapterLink', () => {
    const a = planChapter(parseMarkdown('# A\n\nSee [chapter 2](02-b.md) for more.'), 'a', '01-a.md')
    const b = planChapter(parseMarkdown('# B\n\nbody'), 'b', '02-b.md')
    const plan = planDocument([a, b], 'Book')
    const paragraph = plan.chapters[0]!.blocks[1] as Extract<Block, { kind: 'paragraph' }>
    expect(paragraph.children[1]).toMatchObject({ kind: 'chapterLink', chapterIndex: 1 })
  })

  it('leaves a genuine external link alone', () => {
    const a = planChapter(parseMarkdown('[docs](https://example.com)'), 'a', '01-a.md')
    const b = planChapter(parseMarkdown('# B'), 'b', '02-b.md')
    const plan = planDocument([a, b], 'Book')
    const paragraph = plan.chapters[0]!.blocks[0] as Extract<Block, { kind: 'paragraph' }>
    expect(paragraph.children[0]).toMatchObject({ kind: 'link', href: 'https://example.com' })
  })

  it('strips a leading "./" and a trailing "#fragment" before matching', () => {
    const a = planChapter(parseMarkdown('[b](./02-b.md#section-3)'), 'a', '01-a.md')
    const b = planChapter(parseMarkdown('# B'), 'b', '02-b.md')
    const plan = planDocument([a, b], 'Book')
    const paragraph = plan.chapters[0]!.blocks[0] as Extract<Block, { kind: 'paragraph' }>
    expect(paragraph.children[0]).toMatchObject({ kind: 'chapterLink', chapterIndex: 1 })
  })

  it('resolves a chapter link nested inside bold text and inside a table cell', () => {
    const a = planChapter(
      parseMarkdown('**[b](02-b.md)**\n\n| Chapter |\n|---|\n| [b](02-b.md) |'),
      'a',
      '01-a.md',
    )
    const b = planChapter(parseMarkdown('# B'), 'b', '02-b.md')
    const plan = planDocument([a, b], 'Book')

    const paragraph = plan.chapters[0]!.blocks[0] as Extract<Block, { kind: 'paragraph' }>
    const bold = paragraph.children[0] as Extract<Inline, { kind: 'bold' }>
    expect(bold.children[0]).toMatchObject({ kind: 'chapterLink', chapterIndex: 1 })

    const table = plan.chapters[0]!.blocks[1] as Extract<Block, { kind: 'table' }>
    expect(table.rows[1]![0]![0]).toMatchObject({ kind: 'chapterLink', chapterIndex: 1 })
  })

  it('does not rewrite chapters that contain no cross-chapter links', () => {
    const a = planChapter(parseMarkdown('plain paragraph'), 'a', '01-a.md')
    const plan = planDocument([a], 'Book')
    expect(plan.chapters[0]).toEqual(a)
  })
})
