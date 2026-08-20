import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileChapterInserts } from '../src/emit/compile.js'
import { planChapter } from '../src/plan/fromAst.js'
import { parseMarkdown } from '../src/parse/toAst.js'
import { technical } from '../src/theme/presets/technical.js'

const source = readFileSync(new URL('./fixtures/m1-sample.md', import.meta.url), 'utf8')
const chapter = planChapter(parseMarkdown(source), 'fallback', 'm1-sample.md')
const TAB_ID = 't.golden'

/**
 * Phase 1+2 only, for one chapter's tab: theme and insert requests, both fully deterministic with no
 * network involved. The style phase (compileChapterStyleRequests) needs a readback — a table's cell
 * indices don't exist before the table itself is inserted — so it's tested separately, against small
 * hand-built fixture Documents modeled on the shapes verified live: see test/table.test.ts and
 * test/compileStyleRequests.test.ts. This is why the golden snapshot here stops at "what gets
 * inserted," not "how it gets styled."
 */
describe('compileChapterInserts — golden request snapshot', () => {
  const compiled = compileChapterInserts(technical, chapter, TAB_ID)

  it('emits a stable, reviewable Request[] for theme + insert phases', () => {
    expect(compiled).toMatchSnapshot()
  })

  it('never sends a wildcard field mask in the theme requests', () => {
    for (const req of compiled.themeRequests) {
      const fields = req.updateNamedStyle?.fields ?? req.updateDocumentStyle?.fields
      if (fields !== undefined) expect(fields).not.toBe('*')
    }
  })

  it('chains every insert via endOfSegmentLocation, scoped to this chapter’s own tab', () => {
    for (const req of compiled.insertRequests) {
      if (req.insertText) expect(req.insertText.endOfSegmentLocation?.tabId).toBe(TAB_ID)
      if (req.insertTable) expect(req.insertTable.endOfSegmentLocation?.tabId).toBe(TAB_ID)
    }
  })

  it('scopes the theme requests to this chapter’s own tab, since named styles are per-tab', () => {
    for (const req of compiled.themeRequests) {
      expect(req.updateDocumentStyle?.tabId ?? req.updateNamedStyle?.tabId).toBe(TAB_ID)
    }
  })

  it('gives the table its own insertTable request, sized from the parsed grid', () => {
    const tableInserts = compiled.insertRequests.filter((r) => r.insertTable)
    expect(tableInserts).toHaveLength(1)
    expect(tableInserts[0]?.insertTable).toMatchObject({ rows: 3, columns: 2 })
  })

  it('splits surrounding text into separate insertText requests around the table', () => {
    const textInserts = compiled.insertRequests.filter((r) => r.insertText)
    // One run before the table, one run after (the fixture has content on both sides).
    expect(textInserts.length).toBeGreaterThanOrEqual(2)
  })

  it('never re-introduces markdown syntax into any inserted text', () => {
    const allText = compiled.insertRequests
      .map((r) => r.insertText?.text ?? '')
      .join('\n')
    expect(allText).not.toContain('|') // the table's pipes
    expect(allText).not.toContain('```') // the fence markers
    expect(allText).toContain('def f(x):') // the fenced code content survived
  })
})
