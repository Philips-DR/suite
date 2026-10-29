import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthProvider } from '../src/auth/types.js'
import type { DocumentInfo } from '../src/drive.js'
import type { LayoutResult } from '../src/verify/layout.js'

/**
 * `buildDocument(..., { replaces })`: the old document is checked before anything is built, built around,
 * and trashed only if the new one comes out clean. Every Google call is stubbed, and what each step is
 * called is recorded in order, because the order is the whole behaviour.
 */
const events: string[] = []
let residue: string[] = []
let layout: LayoutResult = { measured: true, pages: 1, lastPageLines: 20, warnings: [] }
let oldDoc: DocumentInfo
let infoFails: Error | undefined
let buildFails: Error | undefined
let trashFails: Error | undefined

vi.mock('../src/emit/document.js', () => ({
  buildFromPlan: vi.fn(() => {
    events.push('build')
    if (buildFails) return Promise.reject(buildFails)
    return Promise.resolve({ documentId: 'new-doc', url: 'https://docs.google.com/document/d/new-doc/edit', imageWarnings: [] })
  }),
}))
vi.mock('../src/verify/readback.js', () => ({
  fetchDocument: vi.fn(() => Promise.resolve({})),
  countParagraphs: () => 3,
  residueFindings: () => residue,
}))
vi.mock('../src/verify/layout.js', () => ({ measureLayout: vi.fn(() => Promise.resolve(layout)) }))
vi.mock('../src/drive.js', () => ({
  documentInfo: vi.fn((_auth: unknown, id: string) => {
    events.push(`info:${id}`)
    return infoFails ? Promise.reject(infoFails) : Promise.resolve(oldDoc)
  }),
  trashDocument: vi.fn((_auth: unknown, id: string) => {
    events.push(`trash:${id}`)
    return trashFails
      ? Promise.reject(trashFails)
      : Promise.resolve({ documentId: id, title: oldDoc.title, trashed: true, restore: 'Restore it from the Trash within 30 days.' })
  }),
  explainFailureWithDrive: (_auth: unknown, error: unknown) => Promise.resolve(error),
  exportDocument: vi.fn(),
  listDocuments: vi.fn(),
}))

const { buildDocument } = await import('../src/operations.js')
const auth: AuthProvider = { kind: 'test', client: () => Promise.reject(new Error('unused')) }

let dir: string
let file: string
beforeEach(async () => {
  events.length = 0
  residue = []
  layout = { measured: true, pages: 1, lastPageLines: 20, warnings: [] }
  infoFails = buildFails = trashFails = undefined
  oldDoc = {
    documentId: 'old-doc', title: 'Ama Mensah', url: 'https://docs.google.com/document/d/old-doc/edit',
    createdTime: '', modifiedTime: '', trashed: false, summary: '',
  }
  dir = await mkdtemp(join(tmpdir(), 'docu-ai-replaces-'))
  file = join(dir, 'cv.md')
  await writeFile(file, '# Ama Mensah\n\nML engineer')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('buildDocument — replaces', () => {
  it('checks the old document first, builds, and only then moves it to the Trash', async () => {
    const result = await buildDocument(auth, { path: file, replaces: 'old-doc' })
    expect(events).toEqual(['info:old-doc', 'build', 'trash:old-doc'])
    expect(result.replaced).toMatchObject({ documentId: 'old-doc', title: 'Ama Mensah', trashed: true })
    expect(result.replaced?.note).toContain('Moved "Ama Mensah" to the Trash')
  })

  it('does not build at all when the old document is already in the Trash', async () => {
    oldDoc = { ...oldDoc, trashed: true }
    await expect(buildDocument(auth, { path: file, replaces: 'old-doc' })).rejects.toThrow(/already in the Trash/)
    expect(events).toEqual(['info:old-doc'])
  })

  it('does not build at all when the old id is not a document docu-ai can see', async () => {
    infoFails = new Error('old-doc is not a Google Doc (it is application/pdf).')
    await expect(buildDocument(auth, { path: file, replaces: 'old-doc' })).rejects.toThrow(/not a Google Doc/)
    expect(events).toEqual(['info:old-doc'])
  })

  it('keeps the old document when the new one has markdown left in it', async () => {
    residue = ['literal ** in "Skills"']
    const result = await buildDocument(auth, { path: file, replaces: 'old-doc' })
    expect(events).toEqual(['info:old-doc', 'build'])
    expect(result.replaced).toMatchObject({ trashed: false })
    expect(result.replaced?.note).toMatch(/Kept "Ama Mensah".*1 piece\(s\) of markdown/)
  })

  it('keeps the old document when the new one has a layout warning', async () => {
    layout = { measured: true, pages: 3, lastPageLines: 2, warnings: ['3 pages, 2 wanted', 'a stray last page'] }
    const result = await buildDocument(auth, { path: file, replaces: 'old-doc' })
    expect(events).not.toContain('trash:old-doc')
    expect(result.replaced?.note).toMatch(/2 layout warning\(s\)/)
  })

  it('does not count a layout that could not be measured as a problem found', async () => {
    layout = { measured: false, reason: 'pdftotext is not installed' }
    const result = await buildDocument(auth, { path: file, replaces: 'old-doc' })
    expect(result.replaced?.trashed).toBe(true)
  })

  it('keeps the old document when the build itself fails', async () => {
    buildFails = new Error('Docs said no')
    await expect(buildDocument(auth, { path: file, replaces: 'old-doc' })).rejects.toThrow('Docs said no')
    expect(events).toEqual(['info:old-doc', 'build'])
  })

  it('still returns the new document when the old one cannot be trashed, and says why', async () => {
    trashFails = new Error('insufficient permission')
    const result = await buildDocument(auth, { path: file, replaces: 'old-doc' })
    expect(result.documentId).toBe('new-doc')
    expect(result.replaced).toMatchObject({ trashed: false })
    expect(result.replaced?.note).toContain('could not be moved to the Trash: insufficient permission')
  })

  it('touches nothing in Drive when it is not asked to replace anything', async () => {
    const result = await buildDocument(auth, { path: file })
    expect(events).toEqual(['build'])
    expect(result.replaced).toBeUndefined()
  })
})
