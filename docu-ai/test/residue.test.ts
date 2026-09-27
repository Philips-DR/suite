import { describe, expect, it } from 'vitest'
import type { docs_v1 } from 'googleapis'
import { residueFindings } from '../src/verify/readback.js'

const CODE_FONT = 'Roboto Mono'
const opts = { codeFont: CODE_FONT }

function doc(paragraphs: docs_v1.Schema$ParagraphElement[][]): docs_v1.Schema$Document {
  return {
    body: {
      content: paragraphs.map((elements) => ({ paragraph: { elements } })),
    },
  }
}

function run(content: string, font?: string): docs_v1.Schema$ParagraphElement {
  return { textRun: { content, textStyle: font ? { weightedFontFamily: { fontFamily: font } } : {} } }
}

describe('residueFindings — anchored checks apply per paragraph, not per run', () => {
  // Reproduces the live-build false positive: "`eligible` + insights score ≥ 50 → `approved`" — a
  // code-styled run for `eligible` followed by a plain run that happens to start with "+ ".
  it('does not flag a plain-text run starting with "+" when the paragraph itself is prose', () => {
    const d = doc([[run('eligible', CODE_FONT), run(' + insights score ≥ 50 → ')]])
    expect(residueFindings(d, opts)).toEqual([])
  })

  it('still flags a real unconverted list marker at the start of a paragraph', () => {
    const d = doc([[run('- this should have become a real bullet')]])
    expect(residueFindings(d, opts)).toEqual([
      expect.stringContaining('unconverted list markers'),
    ])
  })

  it('does not flag an ATX-heading-like "#" at the start of a degraded code line', () => {
    // A Python comment as the first (and only) run of a degraded fenced-code paragraph.
    const d = doc([[run('# a real comment, not a heading', CODE_FONT)]])
    expect(residueFindings(d, opts)).toEqual([])
  })

  it('still flags a real unconverted ATX heading', () => {
    const d = doc([[run('## this markdown heading marker leaked through')]])
    expect(residueFindings(d, opts)).toEqual([expect.stringContaining('ATX heading markers')])
  })
})

describe('residueFindings — content checks exempt code-styled runs', () => {
  // Reproduces: `parse_document(..., **options)` and `+ - * / **` inside inline code.
  it('does not flag "**" inside a code-styled run (e.g. Python **kwargs)', () => {
    const d = doc([[run('parse_document(file_bytes, **options)', CODE_FONT)]])
    expect(residueFindings(d, opts)).toEqual([])
  })

  // Reproduces: `"running"|"awaiting_user"|"completed"` and a Mermaid-style edge label inside code.
  it('does not flag "|" pairs inside a code-styled run', () => {
    const d = doc([[run('"running"|"awaiting_user"|"completed"', CODE_FONT)]])
    expect(residueFindings(d, opts)).toEqual([])
  })

  it('does not flag a backtick inside a code-styled run', () => {
    const d = doc([[run('a `nested` backtick', CODE_FONT)]])
    expect(residueFindings(d, opts)).toEqual([])
  })

  it('still flags "**" left over in ordinary prose', () => {
    const d = doc([[run('this **should** have been bold, not literal')]])
    expect(residueFindings(d, opts)).toEqual([expect.stringContaining('bold markers')])
  })

  it('still flags a literal markdown table row surviving in prose', () => {
    const d = doc([[run('| a | b |')]])
    expect(residueFindings(d, opts)).toEqual([expect.stringContaining('table pipes')])
  })

  it('checks each run independently, so one styled code span does not shield its prose neighbours', () => {
    const d = doc([[run('this has **markers** outside code, then '), run('code(**kw)', CODE_FONT)]])
    expect(residueFindings(d, opts)).toEqual([expect.stringContaining('bold markers')])
  })
})

describe('residueFindings — no residue', () => {
  it('reports nothing for a clean prose paragraph', () => {
    const d = doc([[run('An ordinary sentence with no markdown syntax at all.')]])
    expect(residueFindings(d, opts)).toEqual([])
  })

  it('skips an empty paragraph without erroring', () => {
    expect(residueFindings(doc([[]]), opts)).toEqual([])
  })
})
