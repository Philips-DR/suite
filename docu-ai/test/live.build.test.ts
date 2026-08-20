import { google } from 'googleapis'
import { describe, expect, it, afterAll } from 'vitest'
import { GoogleOAuthProvider } from '../src/auth/google.js'
import { buildFromPlan } from '../src/emit/document.js'
import { parseMarkdown } from '../src/parse/toAst.js'
import { planChapter, planDocument } from '../src/plan/fromAst.js'
import { technical } from '../src/theme/presets/technical.js'
import { fetchDocument, residueFindings, tabBody } from '../src/verify/readback.js'

/**
 * The third documented testing tier — "live integration, gated behind an env var" — made real. Every
 * earlier live check in this project's history was an ad hoc scratch script, run once by hand and
 * discarded; this is the one that stays, so a future change can be checked against the real API
 * without reinventing a probe from scratch. Opt in with:
 *
 *   npm run test:live
 *
 * Skipped by default, and skipped (not failed) if no token is cached, so `npm test` keeps the hard
 * rule intact: it must pass with no Google credentials present. Setting the env var without a cached
 * token IS a failure, though — that's an explicit ask this suite can't silently ignore.
 */
const LIVE = process.env.DOCU_AI_LIVE_TESTS === '1'

const CHAPTER_A = `# Chapter A

## Section

A paragraph with \`inline code\` and **bold**.

- item one
- item two

| Col 1 | Col 2 |
|---|---|
| a | b |
`

const CHAPTER_B = `# Chapter B

Just a short paragraph, to prove a second tab gets its own content.
`

describe.skipIf(!LIVE)('live build — the real API, real readback, real residue lint', () => {
  const auth = new GoogleOAuthProvider()
  let documentId: string

  afterAll(async () => {
    if (!documentId) return
    const drive = google.drive({ version: 'v3', auth: await auth.client() })
    await drive.files.update({ fileId: documentId, requestBody: { trashed: true } })
  })

  it('builds a tabbed document end to end and passes every readback assertion', async () => {
    const chapters = [
      planChapter(parseMarkdown(CHAPTER_A), 'chapter-a'),
      planChapter(parseMarkdown(CHAPTER_B), 'chapter-b'),
    ]
    const plan = planDocument(chapters, 'Live Test Document')

    const built = await buildFromPlan(auth, { theme: technical, plan })
    documentId = built.documentId

    const doc = await fetchDocument(auth, documentId)

    // Cover + two chapter tabs, in order, correctly titled.
    const titles = (doc.tabs ?? []).map((t) => t.tabProperties?.title)
    expect(titles).toEqual(['Contents', 'Chapter A', 'Chapter B'])

    const [coverTab, chapterATab, chapterBTab] = doc.tabs!
    const coverTabId = coverTab!.tabProperties!.tabId!
    const chapterATabId = chapterATab!.tabProperties!.tabId!
    const chapterBTabId = chapterBTab!.tabProperties!.tabId!

    // The table's cells actually got filled — not just an empty grid.
    const chapterABody = tabBody(doc, chapterATabId)!
    const tableElement = chapterABody.content!.find((e) => e.table)!
    const cellTexts = tableElement.table!.tableRows!.map((row) =>
      row.tableCells!.map((cell) =>
        (cell.content ?? []).flatMap((p) => p.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? '').join('').trim(),
      ),
    )
    expect(cellTexts).toEqual([
      ['Col 1', 'Col 2'],
      ['a', 'b'],
    ])

    // The cover's table of contents genuinely points at each chapter's own heading.
    const coverBody = tabBody(doc, coverTabId)!
    const links = coverBody
      .content!.flatMap((e) => e.paragraph?.elements ?? [])
      .filter((e) => e.textRun?.textStyle?.link)
      .map((e) => ({ text: e.textRun!.content, link: e.textRun!.textStyle!.link! }))
    expect(links).toHaveLength(2)
    expect(links[0]?.text).toBe('Chapter A')
    expect(links[0]?.link.heading?.tabId).toBe(chapterATabId)
    expect(links[1]?.text).toBe('Chapter B')
    expect(links[1]?.link.heading?.tabId).toBe(chapterBTabId)

    // Each link's headingId matches that chapter's own H1 — not some other paragraph's.
    const chapterAH1 = chapterABody.content!.find(
      (e) => e.paragraph?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    expect(links[0]?.link.heading?.id).toBe(chapterAH1?.paragraph?.paragraphStyle?.headingId)

    // The headline requirement, checked against the real, fully-built document.
    expect(residueFindings(doc, { codeFont: technical.code.font })).toEqual([])
  }, 60_000)
})
