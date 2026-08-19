import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planChapter } from '../src/plan/fromAst.js'
import { parseMarkdown } from '../src/parse/toAst.js'
import type { Block, Inline } from '../src/plan/types.js'

function plan(markdown: string) {
  return planChapter(parseMarkdown(markdown), 'fallback')
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
    expect(code).toEqual({ kind: 'code-block', lang: 'python', code: 'x = 1' })
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
