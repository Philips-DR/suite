import { basename } from 'node:path'
import { GoogleOAuthProvider, hasCachedToken, tokenPath } from './auth/google.js'
import { buildFromPlan, createThemedDocument } from './emit/document.js'
import type { TextBlock } from './emit/text.js'
import { loadChapterFiles } from './parse/loadDir.js'
import { parseMarkdown } from './parse/toAst.js'
import { planChapter, planDocument } from './plan/fromAst.js'
import { plain, type Block } from './plan/types.js'
import { formatReport, probeAssumptions, writeReport } from './probe/assumptions.js'
import { technical } from './theme/presets/technical.js'
import { countParagraphs, fetchDocument, namedStyleSummary, residueFindings } from './verify/readback.js'

const USAGE = `docu-ai — markdown to Google Docs

  npm run auth                       authorise against Google and cache the refresh token
  npm run probe                      verify assumptions against the live API (fonts, tabs, line breaks)
  npm run m0                         build the M0 proof document
  npm start -- preview <dir>         parse + plan a folder and print its structure — no network, no quota spent
  npm start -- build <dir> [title]   build a doc: one tab per chapter, plus a cover with a clickable TOC
  npm start -- lint <documentId>     re-run the residue lint against an already-built document

See SETUP.md for the one-time Google Cloud setup.
`

async function cmdAuth(): Promise<void> {
  const auth = new GoogleOAuthProvider()
  await auth.client()
  process.stdout.write(`\nAuthorised. Refresh token cached at ${tokenPath()}\n`)
}

async function cmdProbe(): Promise<void> {
  const auth = new GoogleOAuthProvider()
  const report = await probeAssumptions(auth, 'probe.pdf')
  const doc = await fetchDocument(auth, report.documentId)
  process.stdout.write(formatReport(report, { paragraphs: countParagraphs(doc) }))
  await writeReport(report, 'probe-report.json')
  process.stdout.write('full report: probe-report.json   exported pdf: probe.pdf\n\n')

  if (!report.controls.trustworthy) {
    process.stdout.write(
      'WARNING: the controls did not behave as expected, so the font results prove nothing.\n' +
        'Fix the probe before trusting any of it.\n\n',
    )
    process.exitCode = 1
  }
}

/**
 * M0: prove the pipeline end to end. Create a document, redefine its named styles from the theme,
 * lay down a title and a couple of headings, then read it back and show what the API says it stored.
 * The font question is settled by `npm run probe`, not here — a readback cannot see a fallback.
 */
async function cmdM0(): Promise<void> {
  const auth = new GoogleOAuthProvider()

  const blocks: TextBlock[] = [
    { runs: plain('docu-ai M0'), style: 'TITLE' },
    { runs: plain('Proving the pipeline before building anything on top of it'), style: 'SUBTITLE' },
    { runs: plain('What this document proves'), style: 'HEADING_1' },
    {
      runs: plain(
        'This document was created by the API, themed by redefining its named styles, and filled ' +
          'with paragraphs that carry no direct formatting at all. Every font, size, and spacing you ' +
          'see is inherited from a named style, which is why the outline pane is populated.',
      ),
      style: 'NORMAL_TEXT',
    },
    { runs: plain('What it deliberately does not prove'), style: 'HEADING_1' },
    {
      runs: plain(
        'That the fonts requested are the fonts rendered. Docs substitutes Arial for a font it does ' +
          'not recognise, and does so at render time, so the API keeps reporting the name it was ' +
          'given. Only the PDF export in the probe can tell the difference.',
      ),
      style: 'NORMAL_TEXT',
    },
    { runs: plain('A third-level heading, for outline depth'), style: 'HEADING_3' },
    {
      runs: plain('If the spacing above this paragraph looks right, the theme reached the document.'),
      style: 'NORMAL_TEXT',
    },
  ]

  const built = await createThemedDocument(auth, {
    title: 'docu-ai M0 — pipeline proof',
    theme: technical,
    blocks,
  })

  const doc = await fetchDocument(auth, built.documentId)
  process.stdout.write(`\n${built.url}\n\n`)
  process.stdout.write(`paragraphs: ${countParagraphs(doc)}\n\nnamed styles as stored:\n`)
  for (const style of namedStyleSummary(doc)) {
    if (!style.font && !style.sizePt) continue
    process.stdout.write(
      `  ${style.type.padEnd(12)} ${(style.font ?? '?').padEnd(18)} ${style.sizePt ?? '?'}pt` +
        `${style.bold ? ' bold' : ''}\n`,
    )
  }

  const residue = residueFindings(doc, { codeFont: technical.code.font })
  process.stdout.write(
    `\nmarkdown residue: ${residue.length === 0 ? 'none' : residue.join('; ')}\n\n`,
  )
}

/**
 * Prints the residue lint's verdict for an already-fetched document and sets the exit code — shared
 * by `build` (checked right after creating a document) and `lint` (checked against an existing one),
 * so the two commands can't quietly drift into reporting this differently.
 */
function reportResidue(doc: Parameters<typeof residueFindings>[0]): void {
  const residue = residueFindings(doc, { codeFont: technical.code.font })
  process.stdout.write(`markdown residue: ${residue.length === 0 ? 'none' : residue.join('; ')}\n\n`)
  if (residue.length > 0) process.exitCode = 1
}

/** Recursively tallies block kinds — blockquotes aren't a kind of their own here, their contents are. */
function countBlockKinds(blocks: Block[], counts: Record<string, number> = {}): Record<string, number> {
  for (const block of blocks) {
    if (block.kind === 'blockquote') {
      countBlockKinds(block.children, counts)
      continue
    }
    counts[block.kind] = (counts[block.kind] ?? 0) + 1
  }
  return counts
}

/**
 * Parse + plan only — no network, no API quota spent. The per-user write quota is tight enough
 * (CLAUDE.md) that being able to sanity-check a folder's structure before committing it to a real
 * build has real value: catches "that heading didn't parse as a heading" before it costs a build.
 */
async function cmdPreview(dir: string | undefined): Promise<void> {
  if (!dir) throw new Error('usage: npm start -- preview <markdown-folder>')

  const files = await loadChapterFiles(dir)
  if (files.length === 0) throw new Error(`no .md files found in ${dir}`)

  process.stdout.write(`${files.length} chapter(s) — plan only, no changes made:\n\n`)
  files.forEach((file, i) => {
    const chapter = planChapter(parseMarkdown(file.source), file.slug)
    const counts = countBlockKinds(chapter.blocks)
    const summary =
      Object.entries(counts)
        .map(([kind, n]) => `${n} ${kind}`)
        .join(', ') || '(empty)'
    process.stdout.write(`${i + 1}. ${chapter.title} (${basename(file.path)})\n   ${summary}\n\n`)
  })
}

/**
 * One chapter per file, one tab per chapter, plus a cover tab (document title + a clickable
 * hand-built table of contents linking to each chapter's own first heading).
 */
async function cmdBuild(dir: string | undefined, title: string | undefined): Promise<void> {
  if (!dir) throw new Error('usage: npm start -- build <markdown-folder> [title]')
  const auth = new GoogleOAuthProvider()

  const files = await loadChapterFiles(dir)
  if (files.length === 0) throw new Error(`no .md files found in ${dir}`)

  const chapters = files.map((file) => planChapter(parseMarkdown(file.source), file.slug))
  // The cover's own title, distinct from any chapter's — chapter 1's title was a reasonable stand-in
  // before there was a cover to put it on, but it's the wrong default now. The folder name is a
  // plain, unsurprising fallback; pass a title explicitly for anything better.
  const plan = planDocument(chapters, title ?? basename(dir))

  process.stdout.write(`${files.length} chapter(s): ${chapters.map((c) => c.title).join(', ')}
`)

  const built = await buildFromPlan(auth, { theme: technical, plan })
  process.stdout.write(`
${built.url}

`)

  const doc = await fetchDocument(auth, built.documentId)
  process.stdout.write(`paragraphs: ${countParagraphs(doc)}\n`)
  reportResidue(doc)
}

/** Re-checks an already-built document without rebuilding it — e.g. after a human has edited it. */
async function cmdLint(documentId: string | undefined): Promise<void> {
  if (!documentId) throw new Error('usage: npm start -- lint <documentId>')
  const auth = new GoogleOAuthProvider()

  const doc = await fetchDocument(auth, documentId)
  process.stdout.write(`paragraphs: ${countParagraphs(doc)}\n`)
  reportResidue(doc)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  switch (command) {
    case 'auth':
      await cmdAuth()
      break
    case 'probe':
      await cmdProbe()
      break
    case 'm0':
      await cmdM0()
      break
    case 'preview':
      await cmdPreview(process.argv[3])
      break
    case 'build':
      await cmdBuild(process.argv[3], process.argv[4])
      break
    case 'lint':
      await cmdLint(process.argv[3])
      break
    case 'status':
      process.stdout.write(
        `token cached: ${(await hasCachedToken()) ? 'yes' : 'no'} (${tokenPath()})\n`,
      )
      break
    default:
      process.stdout.write(USAGE)
      if (command !== undefined && command !== '--help' && command !== 'help') process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`)
  process.exitCode = 1
})
