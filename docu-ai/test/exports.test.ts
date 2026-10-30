import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExportResult } from '../src/drive.js'
import { exportName, saveExport } from '../src/exports.js'

/**
 * Saving an export for mail-ai to attach. The name is chosen by a model and seen by a recruiter, so it is checked
 * like an uploaded file's; and what is already in the folder is never overwritten.
 */

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'docu-ai-exports-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const WORD = Buffer.from('PK\u0003\u0004 a word file')
const docx = (filename = 'Philip Baah Afriyie.docx'): ExportResult =>
  ({ documentId: 'doc1', format: 'docx', filename, bytes: WORD })

describe('the name a saved file gets', () => {
  it('takes the name asked for, adding the extension the format needs', () => {
    expect(exportName('Philip_Baah_Afriyie_CV', 'x.docx', 'docx')).toBe('Philip_Baah_Afriyie_CV.docx')
    expect(exportName('Philip_Baah_Afriyie_CV.docx', 'x.docx', 'docx')).toBe('Philip_Baah_Afriyie_CV.docx')
    expect(exportName('Cover letter.PDF', 'x.pdf', 'pdf')).toBe('Cover letter.PDF')
  })

  it("falls back to the document's own name", () => {
    expect(exportName(undefined, 'Philip Baah Afriyie.docx', 'docx')).toBe('Philip Baah Afriyie.docx')
    expect(exportName('   ', 'Philip Baah Afriyie.pdf', 'pdf')).toBe('Philip Baah Afriyie.pdf')
  })

  it("refuses a name ending in the other format's extension rather than giving it two", () => {
    expect(() => exportName('cv.pdf', 'x.docx', 'docx')).toThrow(/ends in \.pdf/)
  })

  it.each([
    ['a slash', '../../etc/cv'],
    ['a backslash', 'a\\b'],
    ['a leading dot', '.hidden'],
    ['a control character', 'cv\u0000'],
    ['a right-to-left override', 'cv\u202excod'],
    ['nothing but the extension', '.docx'],
    ['a name far too long', 'x'.repeat(200)],
  ])('refuses %s', (_why, name) => {
    expect(() => exportName(name, 'x.docx', 'docx')).toThrow(/not a name a file can be saved under/)
  })
})

describe('saving', () => {
  it('writes the bytes into the folder and returns where, not the bytes', async () => {
    const saved = await saveExport(dir, docx(), 'Philip_Baah_Afriyie_CV.docx')
    expect(saved).toEqual({ documentId: 'doc1', format: 'docx', filename: 'Philip_Baah_Afriyie_CV.docx', path: join(dir, 'Philip_Baah_Afriyie_CV.docx'), size: WORD.length })
    expect((await readFile(saved.path)).equals(WORD)).toBe(true)
    expect(saved).not.toHaveProperty('data')
  })

  it('never overwrites what is there: a second save of the same name gets a number', async () => {
    await writeFile(join(dir, 'cv.docx'), 'an earlier version, kept')
    const saved = await saveExport(dir, docx(), 'cv')
    expect(saved.filename).toBe('cv (2).docx')
    expect(await readFile(join(dir, 'cv.docx'), 'utf8')).toBe('an earlier version, kept')
  })

  it('makes the folder if it is not there yet', async () => {
    const saved = await saveExport(join(dir, 'exports'), docx(), 'cv')
    expect(saved.path).toBe(join(dir, 'exports', 'cv.docx'))
  })

  it('refuses with no folder, and writes nothing', async () => {
    await expect(saveExport(undefined, docx(), 'cv')).rejects.toThrow(/No exports folder/)
    await expect(saveExport('', docx(), 'cv')).rejects.toThrow(/No exports folder/)
  })

  it('a refused name writes nothing at all', async () => {
    await expect(saveExport(dir, docx(), '../escape')).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })
})
