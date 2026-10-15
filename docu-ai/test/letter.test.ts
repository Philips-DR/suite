import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEMES, buildDocument } from '../src/operations.js'
import { assertVerifiedFonts } from '../src/theme/fonts.js'
import { letter } from '../src/theme/presets/letter.js'
import { resume } from '../src/theme/presets/resume.js'
import type { AuthProvider } from '../src/auth/types.js'

/**
 * The first answer to "build my cover letter" was the résumé look, and a real letter came out cramped and
 * top-heavy: 10pt type, 4pt between paragraphs, a 22pt name over a page that was 60% empty. These pin what
 * makes a letter a different look from a CV, so it is not quietly tuned back into one.
 */
describe('the letter look', () => {
  it('is offered by name, beside the other two', () => {
    expect(Object.keys(THEMES)).toEqual(['technical', 'resume', 'letter'])
    expect(THEMES.letter).toBe(letter)
  })

  it('uses only fonts a probe has watched embed in a real PDF', () => {
    expect(() => {
      assertVerifiedFonts(letter)
    }).not.toThrow()
  })

  it('sets the body larger than a résumé’s, with more room between the lines and between the blocks', () => {
    expect(letter.body.text.sizePt).toBeGreaterThan(resume.body.text.sizePt)
    expect(letter.body.para.lineSpacingPct).toBeGreaterThan(resume.body.para.lineSpacingPct ?? 0)
    // A letter is a stack of short blocks; the gap between them is what reads as a letter.
    expect(letter.body.para.spaceBelowPt).toBeGreaterThanOrEqual(2 * (resume.body.para.spaceBelowPt ?? 0))
  })

  it('has wider side margins than a résumé and a modest name over the first block', () => {
    expect(letter.page.marginLeftPt).toBeGreaterThan(resume.page.marginLeftPt)
    expect(letter.page.marginRightPt).toBeGreaterThan(resume.page.marginRightPt)
    expect(letter.heading1.text.sizePt).toBeLessThan(resume.heading1.text.sizePt)
  })

  it('runs the full measure, like the résumé: no narrowed column to waste a page', () => {
    for (const block of [letter.body, letter.heading1, letter.heading2, letter.heading3]) {
      expect(block.para.indentEndPt).toBe(0)
    }
  })

  it('asks for no lead-line gluing: a letter has no roles or projects', () => {
    expect(letter.keepLeadWithNext).toBeUndefined()
  })
})

describe('building a letter', () => {
  // The same rule the résumé holds: one document by one person. Refused before any network, so a stub that
  // explodes on use proves it.
  it('is one file, and says so when given several', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docu-ai-letter-'))
    try {
      await writeFile(join(dir, '01.md'), '# A\n\nBody.\n', 'utf8')
      await writeFile(join(dir, '02.md'), '# B\n\nBody.\n', 'utf8')
      const auth: AuthProvider = { kind: 'test', client: () => Promise.reject(new Error('must not be used')) }
      await expect(buildDocument(auth, { path: dir, theme: letter })).rejects.toThrow(/a letter is one document/)
      await expect(buildDocument(auth, { path: dir, theme: resume })).rejects.toThrow(/a résumé is one document/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
