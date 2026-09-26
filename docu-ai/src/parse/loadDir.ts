import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface ChapterFile {
  /** Filename without extension, used only as a fallback title until plan/ derives one from the H1. */
  slug: string
  path: string
  source: string
}

/**
 * A folder of chapters, or a single markdown file as the only chapter.
 *
 * The single-file case exists because the tools that feed docu-ai do not write into folders of
 * their own: meet-ai's notes land beside every other transcript it has produced, so building
 * "the folder" would compile all of them into one document. `single` tells the caller which it
 * got, since a lone file wants no cover and no one-entry table of contents.
 */
export async function loadChapters(path: string): Promise<{ files: ChapterFile[]; single: boolean }> {
  const info = await stat(path)
  if (info.isFile()) {
    if (!/\.md$/i.test(path)) throw new Error(`${path} is not a markdown file`)
    return {
      files: [{ slug: basename(path).replace(/\.md$/i, ''), path, source: await readFile(path, 'utf8') }],
      single: true,
    }
  }
  return { files: await loadChapterFiles(path), single: false }
}

/**
 * One file = one chapter = one tab. If a SUMMARY.md manifest exists, it fixes the order; otherwise
 * files sort by filename, which is why the corpus uses a numeric prefix (00-, 01-, 02-...).
 */
export async function loadChapterFiles(dir: string): Promise<ChapterFile[]> {
  const manifest = await readManifest(dir)
  const names = manifest ?? (await discoverMarkdownFiles(dir))

  return Promise.all(
    names.map(async (name) => ({
      slug: name.replace(/\.md$/i, ''),
      path: join(dir, name),
      source: await readFile(join(dir, name), 'utf8'),
    })),
  )
}

async function discoverMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name) && e.name.toUpperCase() !== 'SUMMARY.MD')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** SUMMARY.md lines of the form `- [Title](file.md)`, in the order they appear. No nesting yet. */
async function readManifest(dir: string): Promise<string[] | undefined> {
  let text: string
  try {
    text = await readFile(join(dir, 'SUMMARY.md'), 'utf8')
  } catch {
    return undefined
  }

  const names: string[] = []
  const linkPattern = /\[[^\]]*\]\(([^)]+\.md)\)/gi
  for (const match of text.matchAll(linkPattern)) {
    // Group 1 is required by the pattern itself, so it's always populated for a successful match.
    names.push(match[1]!)
  }
  return names.length > 0 ? names : undefined
}
