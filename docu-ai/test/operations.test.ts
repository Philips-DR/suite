import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthProvider } from '../src/auth/types.js'

/**
 * buildDocument's one decision that is not delegated: whether the document gets a cover. The
 * API calls themselves are covered by the emit snapshots and the live test; here buildFromPlan
 * and the readback are stubbed so the decision can be checked with no network at all.
 */
const calls: { cover?: boolean; title: string; chapters: number; theme?: string }[] = []

vi.mock('../src/emit/document.js', () => ({
  buildFromPlan: vi.fn((_auth: unknown, opts: { cover?: boolean; theme: { name?: string }; plan: { title: string; chapters: unknown[] } }) => {
    calls.push({ cover: opts.cover, title: opts.plan.title, chapters: opts.plan.chapters.length })
    themes.push(opts.theme)
    return Promise.resolve({ documentId: 'doc-1', url: 'https://docs.google.com/document/d/doc-1/edit', imageWarnings: [] })
  }),
}))
vi.mock('../src/verify/readback.js', () => ({
  fetchDocument: vi.fn(() => Promise.resolve({})),
  countParagraphs: () => 0,
  residueFindings: () => [],
}))

const themes: unknown[] = []
const { THEMES, buildDocument } = await import('../src/operations.js')
const auth: AuthProvider = { kind: 'test', client: () => Promise.reject(new Error('unused')) }

let dir: string
beforeEach(async () => {
  calls.length = 0
  themes.length = 0
  dir = await mkdtemp(join(tmpdir(), 'docu-ai-ops-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('buildDocument — cover or not', () => {
  it('gives a single file no cover, and titles the document from its own heading', async () => {
    await writeFile(join(dir, 'x.notes.md'), '# Board meeting — notes\n\nbody')
    await buildDocument(auth, { path: join(dir, 'x.notes.md') })
    expect(calls).toEqual([{ cover: false, title: 'Board meeting — notes', chapters: 1 }])
  })

  it('keeps the cover for a folder, as every folder build always has', async () => {
    await writeFile(join(dir, '01-a.md'), '# A')
    await writeFile(join(dir, '02-b.md'), '# B')
    await buildDocument(auth, { path: dir, title: 'Handbook' })
    expect(calls).toEqual([{ cover: true, title: 'Handbook', chapters: 2 }])
  })

  it('lets an explicit title win for a single file too', async () => {
    await writeFile(join(dir, 'x.md'), '# Heading')
    await buildDocument(auth, { path: join(dir, 'x.md'), title: 'Dad — 12 August' })
    expect(calls[0]?.title).toBe('Dad — 12 August')
  })
})

// Found testing the assistant: asked to "create a CV", it could only build with the technical
// look, because the model's door offered no choice -- a résumé came out as a spec document.
describe('buildDocument — choosing a look', () => {
  it('builds in the look asked for', async () => {
    await writeFile(join(dir, 'cv.md'), '# Ama Mensah\n\nML engineer')
    await buildDocument(auth, { path: join(dir, 'cv.md'), theme: THEMES.resume })
    expect(themes).toEqual([THEMES.resume])
    expect(calls[0]).toMatchObject({ cover: false, title: 'Ama Mensah' })
  })

  it('refuses a résumé made of several files, as the CLI always has', async () => {
    await writeFile(join(dir, '01-a.md'), '# A')
    await writeFile(join(dir, '02-b.md'), '# B')
    await expect(buildDocument(auth, { path: dir, theme: THEMES.resume })).rejects.toThrow(/a résumé is one document/)
    expect(calls).toEqual([])
  })

  it('still defaults to the technical look', async () => {
    await writeFile(join(dir, 'x.md'), '# X')
    await buildDocument(auth, { path: join(dir, 'x.md') })
    expect(themes).toEqual([THEMES.technical])
  })
})
