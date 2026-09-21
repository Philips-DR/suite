import { basename } from 'node:path'
import type { AuthProvider } from './auth/types.js'
import { buildFromPlan } from './emit/document.js'
import { loadChapterFiles } from './parse/loadDir.js'
import { parseMarkdown } from './parse/toAst.js'
import { planChapter, planDocument } from './plan/fromAst.js'
import type { Block } from './plan/types.js'
import { technical } from './theme/presets/technical.js'
import type { Theme } from './theme/types.js'
import { countParagraphs, fetchDocument, residueFindings } from './verify/readback.js'

/**
 * What docu-ai can be asked to do, as data in and data out.
 *
 * Both front doors sit on this: the CLI formats these results for a person, the MCP server returns
 * them as JSON to a model. Neither wraps the other, which is the point — a front door that
 * delegates to the other one inherits its output format, its exit codes and its assumptions about
 * who is reading, and the two drift the moment either is changed for its own audience.
 *
 * Nothing here writes to stdout or sets an exit code. That is a front door's job.
 */

/** Recursively tallies block kinds — blockquotes aren't a kind of their own here, their contents are. */
export function countBlockKinds(
  blocks: Block[],
  counts: Record<string, number> = {},
): Record<string, number> {
  for (const block of blocks) {
    if (block.kind === 'blockquote') {
      countBlockKinds(block.children, counts)
      continue
    }
    counts[block.kind] = (counts[block.kind] ?? 0) + 1
  }
  return counts
}

export interface ChapterPreview {
  title: string
  file: string
  blocks: Record<string, number>
}

export interface PreviewResult {
  chapters: ChapterPreview[]
}

/**
 * Parse + plan only — no network, no API quota spent, nothing created.
 *
 * Every tool in this suite owes a preview: it is what turns human-in-the-loop from a convention
 * somebody has to remember into a property of the tool. It is also the only operation here that
 * takes no AuthProvider, and that is the whole idea.
 */
export async function previewFolder(dir: string): Promise<PreviewResult> {
  const files = await loadChapterFiles(dir)
  if (files.length === 0) throw new Error(`no .md files found in ${dir}`)

  return {
    chapters: files.map((file) => {
      const chapter = planChapter(parseMarkdown(file.source), file.slug, basename(file.path))
      return {
        title: chapter.title,
        file: basename(file.path),
        blocks: countBlockKinds(chapter.blocks),
      }
    }),
  }
}

export interface BuildResult {
  documentId: string
  url: string
  title: string
  chapters: string[]
  paragraphs: number
  residue: string[]
  imageWarnings: string[]
}

/**
 * One chapter per file, one tab per chapter, plus a cover tab with a clickable table of contents.
 *
 * The readback and residue lint are part of the operation rather than a separate step, because a
 * build nobody checked is a build nobody can trust — and the caller has the document id either way.
 */
export async function buildDocument(
  auth: AuthProvider,
  opts: { dir: string; title?: string; theme?: Theme },
): Promise<BuildResult> {
  const theme = opts.theme ?? technical
  const files = await loadChapterFiles(opts.dir)
  if (files.length === 0) throw new Error(`no .md files found in ${opts.dir}`)

  const chapters = files.map((file) =>
    planChapter(parseMarkdown(file.source), file.slug, basename(file.path)),
  )
  // The folder name is a plain, unsurprising fallback for the cover's own title; pass one
  // explicitly for anything better.
  const title = opts.title ?? basename(opts.dir)
  const plan = planDocument(chapters, title)

  const built = await buildFromPlan(auth, { theme, plan })
  const doc = await fetchDocument(auth, built.documentId)

  return {
    documentId: built.documentId,
    url: built.url,
    title,
    chapters: chapters.map((c) => c.title),
    paragraphs: countParagraphs(doc),
    residue: residueFindings(doc, { codeFont: theme.code.font }),
    imageWarnings: built.imageWarnings,
  }
}

export interface LintResult {
  documentId: string
  paragraphs: number
  residue: string[]
}

/**
 * Re-run the residue lint against an already-built document.
 *
 * `lint` is given a documentId, not a theme, so it cannot know which one built the document. Both
 * presets use the same mono family, so the code-run exemption resolves identically either way.
 */
export async function lintDocument(
  auth: AuthProvider,
  documentId: string,
  theme: Theme = technical,
): Promise<LintResult> {
  const doc = await fetchDocument(auth, documentId)
  return {
    documentId,
    paragraphs: countParagraphs(doc),
    residue: residueFindings(doc, { codeFont: theme.code.font }),
  }
}
