import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChapterFiles, loadChapters } from '../src/parse/loadDir.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docu-ai-loaddir-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content, 'utf8')
}

describe('loadChapterFiles — no manifest', () => {
  it('sorts filenames numerically, matching the corpus’s 00-, 01-, 02- convention', async () => {
    await put('02-c.md', 'c')
    await put('10-j.md', 'j')
    await put('01-b.md', 'b')
    const files = await loadChapterFiles(dir)
    expect(files.map((f) => f.slug)).toEqual(['01-b', '02-c', '10-j'])
  })

  it('reads the file content and derives slug from the filename without extension', async () => {
    await put('00-overview.md', '# Hi')
    const [file] = await loadChapterFiles(dir)
    expect(file).toMatchObject({ slug: '00-overview', source: '# Hi' })
    expect(file?.path.endsWith('00-overview.md')).toBe(true)
  })

  it('ignores non-markdown files', async () => {
    await put('a.md', 'a')
    await put('notes.txt', 'ignore me')
    const files = await loadChapterFiles(dir)
    expect(files.map((f) => f.slug)).toEqual(['a'])
  })
})

describe('loadChapterFiles — with SUMMARY.md', () => {
  it('orders chapters by the manifest, not by filename', async () => {
    await put('b.md', 'B')
    await put('a.md', 'A')
    await put('SUMMARY.md', '- [Second](b.md)\n- [First](a.md)\n')
    const files = await loadChapterFiles(dir)
    expect(files.map((f) => f.slug)).toEqual(['b', 'a'])
  })

  it('excludes SUMMARY.md itself from the chapter list when discovered without a manifest match', async () => {
    await put('a.md', 'A')
    await put('SUMMARY.md', 'not a link list, just prose')
    const files = await loadChapterFiles(dir)
    expect(files.map((f) => f.slug)).toEqual(['a'])
  })
})

describe('loadChapters — a folder or a single file', () => {
  it('treats a single .md file as a one-chapter source', async () => {
    await put('notes.md', '# Meeting notes\n\nbody')
    const { files, single } = await loadChapters(join(dir, 'notes.md'))
    expect(single).toBe(true)
    expect(files.map((f) => f.slug)).toEqual(['notes'])
  })

  // Found building meet-ai's notes into a Doc: the notes land beside every other transcript the
  // tool has written, so the only way to build just them was to build a folder of everything.
  it('builds only the named file, not its neighbours', async () => {
    await put('20260812.notes.md', '# Notes')
    await put('20260812.md', '# The full transcript')
    await put('Voice 260915.md', '# A different meeting')
    const { files } = await loadChapters(join(dir, '20260812.notes.md'))
    expect(files).toHaveLength(1)
  })

  it('still treats a folder as a folder', async () => {
    await put('01-a.md', '# A')
    await put('02-b.md', '# B')
    const { files, single } = await loadChapters(dir)
    expect(single).toBe(false)
    expect(files).toHaveLength(2)
  })

  it('refuses a file that is not markdown', async () => {
    await put('audio.flac', 'fLaC')
    await expect(loadChapters(join(dir, 'audio.flac'))).rejects.toThrow('not a markdown file')
  })
})
