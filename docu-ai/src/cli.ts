import { basename } from 'node:path'
import { GoogleOAuthProvider, hasCachedToken, tokenPath } from './auth/google.js'
import { buildFromPlan, createThemedDocument } from './emit/document.js'
import type { TextBlock } from './emit/text.js'
import { buildDocument, lintDocument, preview } from './operations.js'
import { loadChapterFiles } from './parse/loadDir.js'
import { parseMarkdown } from './parse/toAst.js'
import { planChapter, planDocument } from './plan/fromAst.js'
import { plain } from './plan/types.js'
import { formatReport, probeAssumptions, writeReport } from './probe/assumptions.js'
import { resume } from './theme/presets/resume.js'
import { technical } from './theme/presets/technical.js'
import { exportPdf } from './verify/pdfFonts.js'
import { countParagraphs, fetchDocument, namedStyleSummary, residueFindings } from './verify/readback.js'
import { tolerateSlowConnections } from './network.js'

const USAGE = `docu-ai — markdown to Google Docs

  npm run auth                       authorise against Google and cache the refresh token
  npm run probe                      verify assumptions against the live API (fonts, tabs, line breaks)
  npm run m0                         build the M0 proof document
  npm start -- preview <dir|file>    parse + plan a folder or one .md file — no network, no quota spent
  npm start -- build <dir|file> [t]  build a doc: a folder gets a tab per chapter and a cover; one file, a single tab
  npm start -- resume <dir> [out]    build a single-tab doc with no cover and export it to PDF
  npm start -- export <docId> [out]  export an already-built document to PDF
  npm start -- lint <documentId>     re-run the residue lint against an already-built document
  npm run mcp                        serve preview/build/lint over MCP on stdio, for a model to call

See SETUP.md for the one-time Google Cloud setup.
`

async function cmdAuth(): Promise<void> {
  const auth = GoogleOAuthProvider.fromEnvironment()
  // authorize(), not client(): the whole point of this command is to replace what's cached, and
  // client() would hand back an expired token rather than re-running consent. See google.ts.
  await auth.authorize()
  process.stdout.write(`\nAuthorised. Refresh token cached at ${tokenPath()}\n`)
}

async function cmdProbe(): Promise<void> {
  const auth = GoogleOAuthProvider.fromEnvironment()
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
  const auth = GoogleOAuthProvider.fromEnvironment()

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
 * by `build` and `resume` (checked right after creating a document) and `lint` (checked against an
 * existing one), so the commands can't quietly drift into reporting this differently.
 *
 * The theme is a parameter rather than hardcoded because the lint's one exemption is code-styled
 * runs, identified by their mono font: a theme whose code font differed from the one passed here
 * would have every inline code span either wrongly exempted or wrongly flagged.
 */
function reportResidue(residue: string[]): void {
  process.stdout.write(`markdown residue: ${residue.length === 0 ? 'none' : residue.join('; ')}\n\n`)
  if (residue.length > 0) process.exitCode = 1
}

/**
 * Parse + plan only — no network, no API quota spent. The per-user write quota is tight enough
 * (CLAUDE.md) that being able to sanity-check a folder's structure before committing it to a real
 * build has real value: catches "that heading didn't parse as a heading" before it costs a build.
 */
async function cmdPreview(dir: string | undefined): Promise<void> {
  if (!dir) throw new Error('usage: npm start -- preview <markdown-folder>')

  const { chapters } = await preview(dir)

  process.stdout.write(`${chapters.length} chapter(s) — plan only, no changes made:\n\n`)
  chapters.forEach((chapter, i) => {
    const summary =
      Object.entries(chapter.blocks)
        .map(([kind, n]) => `${n} ${kind}`)
        .join(', ') || '(empty)'
    process.stdout.write(`${i + 1}. ${chapter.title} (${chapter.file})\n   ${summary}\n\n`)
  })
}

/**
 * One chapter per file, one tab per chapter, plus a cover tab (document title + a clickable
 * hand-built table of contents linking to each chapter's own first heading).
 */
async function cmdBuild(dir: string | undefined, title: string | undefined): Promise<void> {
  if (!dir) throw new Error('usage: npm start -- build <markdown-folder> [title]')
  const auth = GoogleOAuthProvider.fromEnvironment()

  const built = await buildDocument(auth, { path: dir, title })

  process.stdout.write(`${built.chapters.length} chapter(s): ${built.chapters.join(', ')}\n`)
  process.stdout.write(`\n${built.url}\n\n`)
  for (const warning of built.imageWarnings) process.stdout.write(`${warning}\n`)
  process.stdout.write(`paragraphs: ${built.paragraphs}\n`)
  reportResidue(built.residue)
}

/**
 * A résumé is a different SHAPE of document from everything else this tool builds, not just a
 * different theme, and the difference is entirely about what the PDF export looks like: Docs
 * auto-inserts a title page per tab when exporting a multi-tab document (CLAUDE.md, M4), so the
 * cover + one-tab-per-chapter structure that makes a good technical manual makes a résumé that opens
 * with two pages of front matter before the candidate's name. Hence `cover: false` and one chapter:
 * a single native tab exports as a plain document with no interstitials at all.
 *
 * The export is part of the command rather than a separate step because a résumé's deliverable is
 * the PDF — the Doc is the intermediate artifact here, which is the reverse of every other command.
 */
async function cmdResume(dir: string | undefined, outPath: string | undefined): Promise<void> {
  if (!dir) throw new Error('usage: npm start -- resume <markdown-folder> [out.pdf]')
  const auth = GoogleOAuthProvider.fromEnvironment()

  const files = await loadChapterFiles(dir)
  if (files.length === 0) throw new Error(`no .md files found in ${dir}`)
  if (files.length > 1) {
    throw new Error(
      `a résumé is one document, but ${dir} holds ${files.length} .md files: ` +
        `${files.map((f) => basename(f.path)).join(', ')}. Use \`build\` for a multi-chapter document.`,
    )
  }

  const chapters = files.map((file) => planChapter(parseMarkdown(file.source), file.slug, basename(file.path)))
  // The document title is the H1 — a résumé's H1 is the candidate's name, which is exactly what the
  // file should be called in Drive. No folder-name fallback worth having here.
  const plan = planDocument(chapters, chapters[0]!.title)

  const built = await buildFromPlan(auth, { theme: resume, plan, cover: false })
  process.stdout.write(`\n${built.url}\n\n`)
  for (const warning of built.imageWarnings) process.stdout.write(`${warning}\n`)

  const doc = await fetchDocument(auth, built.documentId)
  process.stdout.write(`paragraphs: ${countParagraphs(doc)}\n`)
  reportResidue(residueFindings(doc, { codeFont: resume.code.font }))

  const out = outPath ?? 'resume.pdf'
  await exportPdf(auth, built.documentId, out)
  process.stdout.write(`exported pdf: ${out}\n\n`)
}

/** Export without rebuilding — for re-exporting after editing the document by hand in Docs. */
async function cmdExport(documentId: string | undefined, outPath: string | undefined): Promise<void> {
  if (!documentId) throw new Error('usage: npm start -- export <documentId> [out.pdf]')
  const auth = GoogleOAuthProvider.fromEnvironment()
  const out = outPath ?? `${documentId}.pdf`
  await exportPdf(auth, documentId, out)
  process.stdout.write(`exported pdf: ${out}\n`)
}

/** Re-checks an already-built document without rebuilding it — e.g. after a human has edited it. */
async function cmdLint(documentId: string | undefined): Promise<void> {
  if (!documentId) throw new Error('usage: npm start -- lint <documentId>')
  const auth = GoogleOAuthProvider.fromEnvironment()

  const result = await lintDocument(auth, documentId)
  process.stdout.write(`paragraphs: ${result.paragraphs}\n`)
  reportResidue(result.residue)
}

async function main(): Promise<void> {
  tolerateSlowConnections()
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
    case 'resume':
      await cmdResume(process.argv[3], process.argv[4])
      break
    case 'export':
      await cmdExport(process.argv[3], process.argv[4])
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
  const message = err instanceof Error ? err.message : String(err)
  // Google's own wording for "this refresh token is dead", which is the single most common failure
  // here: the OAuth app sits in "Testing" publishing status, where refresh tokens last 7 days.
  const hint = message.includes('invalid_grant')
    ? '\n\nThat refresh token has expired or been revoked. Run `npm run auth` to sign in again.\n' +
      'To stop it expiring weekly, move the OAuth consent screen off "Testing" — see SETUP.md.'
    : ''
  process.stderr.write(`\n${message}${hint}\n\n`)
  process.exitCode = 1
})
