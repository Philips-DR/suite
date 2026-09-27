import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileChapterInserts } from '../src/emit/compile.js'
import { namedStyleRequests, paragraphStyleFor } from '../src/emit/namedStyles.js'
import { parseMarkdown } from '../src/parse/toAst.js'
import { planChapter } from '../src/plan/fromAst.js'
import { assertVerifiedFonts } from '../src/theme/fonts.js'
import { resume } from '../src/theme/presets/resume.js'
import { technical } from '../src/theme/presets/technical.js'
import type { BlockSpec } from '../src/theme/types.js'

const source = readFileSync(new URL('./fixtures/resume-shape.md', import.meta.url), 'utf8')
const chapter = planChapter(parseMarkdown(source), 'fallback', 'resume-shape.md')

/** Every style a résumé's prose actually lands in. Excludes codeBlock, which pins its own indents. */
const PROSE: Array<[string, BlockSpec]> = [
  ['title', resume.title],
  ['subtitle', resume.subtitle],
  ['heading1', resume.heading1],
  ['heading2', resume.heading2],
  ['heading3', resume.heading3],
  ['body', resume.body],
]

describe('the résumé theme', () => {
  // A résumé silently rendered in Arial is the worst possible document to get this wrong on.
  it('uses only fonts a probe has watched embed in a real PDF', () => {
    expect(() => {
      assertVerifiedFonts(resume)
    }).not.toThrow()
  })

  // technical narrows prose to a comfortable reading measure; a résumé is scanned, not read, and an
  // inch of dead right margin costs a line per bullet. Pinned to 0, never merely left unset.
  it('pins every prose style to the full page measure', () => {
    for (const [name, spec] of PROSE) {
      expect(spec.para.indentEndPt, name).toBe(0)
      expect(technical.body.para.indentEndPt).toBeGreaterThan(0) // the contrast is the point
    }
  })

  it('keeps the three heading levels distinguishable by size', () => {
    const sizes = [resume.heading1, resume.heading2, resume.heading3].map((h) => h.text.sizePt)
    expect(sizes[0]).toBeGreaterThan(sizes[1]!)
    expect(sizes[1]).toBeGreaterThan(sizes[2]!)
  })

  // heading2 and heading3 sit only 1.5pt apart, which size alone cannot carry — the rule under a
  // section heading is what actually separates "EXPERIENCE" from a job title beneath it.
  it('gives section headings a rule, and gives it only to them', () => {
    expect(resume.heading2.para.borderBottom).toBeDefined()
    expect(resume.heading1.para.borderBottom).toBeUndefined()
    expect(resume.heading3.para.borderBottom).toBeUndefined()
    expect(resume.body.para.borderBottom).toBeUndefined()
  })

  it('keeps a role heading with the bullets it introduces, so a page break cannot strand it', () => {
    expect(resume.heading2.para.keepWithNext).toBe(true)
    expect(resume.heading3.para.keepWithNext).toBe(true)
  })

  it('emits a stable named-style request shape', () => {
    expect(namedStyleRequests(resume)).toMatchSnapshot()
  })
})

/**
 * CLAUDE.md: "Paragraph borders cannot be partially updated. Setting `borderLeft` means supplying the
 * complete `ParagraphBorder` — color, width, padding, dashStyle." ParaBorderSpec makes three of those
 * mandatory at the type level and emit/namedStyles.ts supplies the fourth, so the way this regresses
 * is someone "simplifying" the emitter, not someone writing a half-filled theme.
 */
describe('paragraphStyleFor — border completeness', () => {
  const { style, fields } = paragraphStyleFor(resume.heading2.para)

  it('supplies every field of ParagraphBorder, never a partial one', () => {
    expect(style.borderBottom).toEqual({
      color: { color: { rgbColor: expect.anything() as unknown } },
      width: { magnitude: 0.75, unit: 'PT' },
      padding: { magnitude: 3, unit: 'PT' },
      dashStyle: 'SOLID',
    })
  })

  it('names border_bottom in the mask, since an unmasked leaf is never written', () => {
    expect(fields).toContain('border_bottom')
  })

  it('omits the border entirely when the theme sets none, rather than sending an empty one', () => {
    const plain = paragraphStyleFor(technical.body.para)
    expect(plain.style.borderBottom).toBeUndefined()
    expect(plain.fields).not.toContain('border_bottom')
  })
})

describe('a résumé-shaped chapter — golden request snapshot', () => {
  const compiled = compileChapterInserts(resume, chapter, 't.resume', new Map())

  it('emits a stable, reviewable Request[]', () => {
    expect(compiled).toMatchSnapshot()
  })

  // The name is the H1, which is what makes it the tab title and the document title in cli.ts.
  it('takes the candidate’s name as the chapter title', () => {
    expect(chapter.title).toBe('Ada Okonkwo')
  })

  it('leaves no markdown residue in anything it inserts', () => {
    const text = compiled.insertRequests.map((r) => r.insertText?.text ?? '').join('\n')
    expect(text).not.toContain('**')
    expect(text).not.toContain('](')
    expect(text).not.toMatch(/^#/m)
    expect(text).toContain('Streaming ingestion.') // the bolded lead-in survived as plain text
  })
})
