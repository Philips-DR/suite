import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileBlocks } from '../src/emit/blocks.js'
import { compileChapterInserts } from '../src/emit/compile.js'
import { namedStyleRequests, paragraphStyleFor } from '../src/emit/namedStyles.js'
import { renderTextBlocks } from '../src/emit/text.js'
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

/**
 * Found on two real résumés in one day: heading3 has keepWithNext, so a role's heading stayed with
 * its dates line — and the pair, with no keepWithNext on the dates line, still fell at the foot of a
 * page while the bullets started the next one. The lead line has to keep with the first bullet too.
 */
describe('a heading’s lead line keeps with what follows it', () => {
  const keepRequests = (theme: typeof resume) => {
    const [segment] = compileBlocks(chapter.blocks, new Map(), theme.keepLeadWithNext)
    if (segment?.kind !== 'text') throw new Error('expected a text segment')
    const texts = segment.textBlocks
    const requests = renderTextBlocks(texts, theme, { startIndex: 1 }).requests
    return { texts, kept: requests.filter((r) => r.updateParagraphStyle?.fields === 'keep_with_next') }
  }

  it('asks it of the résumé theme, for section and role or project headings', () => {
    expect(resume.keepLeadWithNext).toEqual([2, 3])
  })

  it('marks the dates line under each role, and nothing else', () => {
    const { texts } = keepRequests(resume)
    const marked = texts.filter((b) => b.keepWithNext).map((b) => JSON.stringify(b.runs))
    expect(marked).toHaveLength(2)
    expect(marked[0]).toContain('Mar 2021')
    expect(marked[1]).toContain('Jan 2019')
  })

  // The fixture's Summary paragraph sits under `## Summary` and is followed by `## Experience`: it is
  // the whole section, so there is nothing to strand it from, and gluing it would chain Summary to
  // Experience to the first role.
  it('does not mark a lead that is the whole entry: the next block is a heading of the same rank', () => {
    const { texts } = keepRequests(resume)
    const summary = texts.find((b) => JSON.stringify(b.runs).includes('track record'))
    expect(summary).toBeDefined()
    expect(summary?.keepWithNext).toBeUndefined()
  })

  it('marks a section’s note that introduces a deeper heading, which is what a stranded “Selected Projects” was', () => {
    const intro = planChapter(
      parseMarkdown('# A\n\n## Selected Projects\n\n*Repositories are private.*\n\n### The project\n\nStack line\n\n- a bullet\n'),
      'x',
      'x.md',
    )
    const [segment] = compileBlocks(intro.blocks, new Map(), resume.keepLeadWithNext)
    if (segment?.kind !== 'text') throw new Error('expected a text segment')
    const kept = segment.textBlocks.filter((b) => b.keepWithNext).map((b) => JSON.stringify(b.runs))
    expect(kept).toHaveLength(2)
    expect(kept[0]).toContain('Repositories are private')
    expect(kept[1]).toContain('Stack line')
  })

  it('does not mark a lead line with nothing after it — the last block has nothing to keep with', () => {
    const { texts } = keepRequests(resume)
    const last = texts[texts.length - 1]!
    expect(JSON.stringify(last.runs)).toContain('Graduated 2018')
    expect(last.keepWithNext).toBeUndefined()
  })

  it('sends one keep_with_next request per marked paragraph, never touching the named style request', () => {
    const { kept } = keepRequests(resume)
    expect(kept).toHaveLength(2)
    expect(kept[0]?.updateParagraphStyle?.paragraphStyle).toEqual({ keepWithNext: true })
  })

  it('leaves a theme that does not ask for it exactly as it was', () => {
    expect(technical.keepLeadWithNext).toBeUndefined()
    const { texts, kept } = keepRequests(technical)
    expect(texts.some((b) => b.keepWithNext)).toBe(false)
    expect(kept).toHaveLength(0)
  })
})
