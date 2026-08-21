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

A paragraph with \`inline code\` and **bold**. See [Chapter B](chapter-b.md) for more.

- item one
- item two

| Col 1 | Col 2 |
|---|---|
| a | [Chapter B](chapter-b.md) |

\`\`\`python
def f(x):
    return x + 1
\`\`\`
`

const CHAPTER_B = `# Chapter B

Just a short paragraph, to prove a second tab gets its own content.

![A Google logo](https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png)

![A local diagram](./diagram.png)
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
      planChapter(parseMarkdown(CHAPTER_A), 'chapter-a', 'chapter-a.md'),
      planChapter(parseMarkdown(CHAPTER_B), 'chapter-b', 'chapter-b.md'),
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
      ['a', 'Chapter B'],
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

    // An ordinary in-body markdown link naming a sibling chapter's own file resolves to Link.heading
    // too, in both prose and a table cell — not the http://chapter-b.md that Google's own Link.url
    // silently produces from a bare relative string (see CLAUDE.md's real-corpus findings).
    const chapterBH1 = tabBody(doc, chapterBTabId)!.content!.find(
      (e) => e.paragraph?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    const chapterBHeadingId = chapterBH1?.paragraph?.paragraphStyle?.headingId

    const proseLink = chapterABody
      .content!.flatMap((e) => e.paragraph?.elements ?? [])
      .find((e) => e.textRun?.content === 'Chapter B')?.textRun?.textStyle?.link
    expect(proseLink?.heading).toEqual({ id: chapterBHeadingId, tabId: chapterBTabId })

    const cellLink = tableElement
      .table!.tableRows![1]!.tableCells![1]!.content!.flatMap((p) => p.paragraph?.elements ?? [])
      .find((e) => e.textRun?.content === 'Chapter B')?.textRun?.textStyle?.link
    expect(cellLink?.heading).toEqual({ id: chapterBHeadingId, tabId: chapterBTabId })

    // M7: a highlighted code block's tokens actually carry distinct colours in the built document —
    // not just the block's own base text colour. This is the exact case that failed silently in
    // development: every request succeeded, but a later block-wide request was overwriting every
    // token's colour with the base one (see CLAUDE.md's M7 note). Checking foregroundColor via
    // readback, not just that a request was sent, is what would have caught that.
    const codeParagraph = chapterABody.content!.find(
      (e) => e.paragraph?.elements?.some((el) => el.textRun?.content?.includes('def')),
    )!.paragraph!
    const runColors = (codeParagraph.elements ?? [])
      .map((el) => el.textRun)
      .filter((run): run is NonNullable<typeof run> => run !== undefined)
      // The paragraph's own trailing newline rides along on the LAST run's content — same quirk the
      // table-cell assertions above already trim around, not new to this test.
      .map((run) => ({ text: run.content?.trim(), color: run.textStyle?.foregroundColor?.color?.rgbColor }))
    const defRun = runColors.find((r) => r.text === 'def')
    const numberRun = runColors.find((r) => r.text === '1')
    expect(defRun?.color).toBeDefined()
    expect(numberRun?.color).toBeDefined()
    expect(defRun?.color).not.toEqual(numberRun?.color)

    // M8: a remote-URL image actually embeds as a real inline object, sized by this theme's own
    // column width rather than left to Docs' own (wider, margin-only) default — not just that a
    // request was sent, but that the readback shows a real embedded object with the right source.
    const chapterBDocumentTab = chapterBTab!.documentTab!
    const inlineObjects = Object.values(chapterBDocumentTab.inlineObjects ?? {})
    expect(inlineObjects).toHaveLength(1)
    const embedded = inlineObjects[0]!.inlineObjectProperties!.embeddedObject!
    expect(embedded.imageProperties?.sourceUri).toBe(
      'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png',
    )
    // The logo's filename says 272x92, but that's the LOGICAL (@1x) size — it's a retina "@2x" asset,
    // so its real pixel dimensions are double that (544x184, confirmed by fetching and parsing it
    // directly), comfortably over the 432pt column: capped, not left at Docs' own wider page-only
    // default. Precise floating-point equality isn't asserted since Google's own EMU-based storage
    // round-trips a clean 432 through a tiny epsilon (e.g. 432.00000000000006).
    expect(embedded.size?.width?.magnitude).toBeCloseTo(432, 5)
    expect(embedded.size?.height?.magnitude).toBeCloseTo(432 * (184 / 544), 5)

    // A local-file image (no public URL) is never embeddable in v1 (see plan.md's M8 note) — it must
    // fall back to its own alt text, visibly, rather than vanish, and the build must say so out loud
    // rather than silently drop it.
    const chapterBBody = chapterBDocumentTab.body!
    const localImageFallback = chapterBBody.content!.some((e) =>
      e.paragraph?.elements?.some((el) => el.textRun?.content?.includes('A local diagram')),
    )
    expect(localImageFallback).toBe(true)
    expect(built.imageWarnings.some((w) => w.includes('local file') && w.includes('diagram.png'))).toBe(true)

    // The headline requirement, checked against the real, fully-built document.
    expect(residueFindings(doc, { codeFont: technical.code.font })).toEqual([])
  }, 60_000)
})
