import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileDocument } from '../src/emit/compile.js'
import { planChapter, planDocument } from '../src/plan/fromAst.js'
import { parseMarkdown } from '../src/parse/toAst.js'
import { technical } from '../src/theme/presets/technical.js'

const source = readFileSync(new URL('./fixtures/m1-sample.md', import.meta.url), 'utf8')
const chapter = planChapter(parseMarkdown(source), 'fallback')
const plan = planDocument([chapter], 'M1 golden sample')

describe('compileDocument — golden request snapshot', () => {
  const compiled = compileDocument(technical, plan)

  it('emits a stable, reviewable Request[] for every phase', () => {
    expect(compiled).toMatchSnapshot()
  })

  it('never sends a wildcard field mask anywhere in the build', () => {
    const all = [...compiled.themeRequests, ...compiled.contentRequests, ...compiled.bulletRequests]
    for (const req of all) {
      const fields =
        req.updateNamedStyle?.fields ??
        req.updateDocumentStyle?.fields ??
        req.updateParagraphStyle?.fields ??
        req.updateTextStyle?.fields
      if (fields !== undefined) expect(fields).not.toBe('*')
    }
  })

  it('puts bullets strictly after content, since they are the only length-changing requests', () => {
    expect(compiled.bulletRequests.length).toBeGreaterThan(0)
    // Nothing in contentRequests may be a createParagraphBullets request.
    expect(compiled.contentRequests.some((r) => r.createParagraphBullets)).toBe(false)
  })

  it('renders the degraded table with no literal pipe character in any inserted text', () => {
    const insert = compiled.contentRequests.find((r) => r.insertText)?.insertText?.text ?? ''
    expect(insert).not.toContain('|')
    expect(insert).toContain('a') // the cell content survived, just not as a markdown table
  })

  it('renders the fenced code block content without its triple-backtick fence markers', () => {
    const insert = compiled.contentRequests.find((r) => r.insertText)?.insertText?.text ?? ''
    expect(insert).not.toContain('```')
    expect(insert).toContain('def f(x):')
  })
})
