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
const calls: { cover?: boolean; title: string; chapters: number }[] = []

vi.mock('../src/emit/document.js', () => ({
  buildFromPlan: vi.fn((_auth: unknown, opts: { cover?: boolean; plan: { title: string; chapters: unknown[] } }) => {
    calls.push({ cover: opts.cover, title: opts.plan.title, chapters: opts.plan.chapters.length })
    return Promise.resolve({ documentId: 'doc-1', url: 'https://docs.google.com/document/d/doc-1/edit', imageWarnings: [] })
  }),
}))
vi.mock('../src/verify/readback.js', () => ({
  fetchDocument: vi.fn(() => Promise.resolve({})),
  countParagraphs: () => 0,
  residueFindings: () => [],
}))

const { buildDocument } = await import('../src/operations.js')
const auth: AuthProvider = { kind: 'test', client: () => Promise.reject(new Error('unused')) }

let dir: string
beforeEach(async () => {
  calls.length = 0
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
