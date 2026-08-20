import { google, type docs_v1 } from 'googleapis'
import type { AuthProvider } from '../auth/types.js'
import type { Chapter, DocPlan } from '../plan/types.js'
import { assertVerifiedFonts } from '../theme/fonts.js'
import type { Theme } from '../theme/types.js'
import { compileChapterContentRequests, compileChapterInserts, compileChapterLengthChangingRequests } from './compile.js'
import { coverContentStyleRequests, coverInsertRequest } from './cover.js'
import { documentStyleRequest, namedStyleRequests } from './namedStyles.js'
import { headingLinkRequests, renderTextBlocks, type TextBlock } from './text.js'
import { fetchDocument, tabBody } from '../verify/readback.js'

/**
 * THE ONLY MODULE IN src/emit/ PERMITTED TO DO I/O. Everything else here is a pure function from a
 * plan to Request[], which is what makes the snapshot tests meaningful.
 */

/** The per-user write quota is tight, so batch hard. Confirm the current figure before tuning. */
export const MAX_REQUESTS_PER_BATCH = 300

export interface BuiltDoc {
  documentId: string
  url: string
}

export function docsUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`
}

export async function docsFor(auth: AuthProvider): Promise<docs_v1.Docs> {
  return google.docs({ version: 'v1', auth: await auth.client() })
}

/**
 * batchUpdate is atomic: one invalid request and nothing in the batch applies. Chunking gives that
 * guarantee up across chunk boundaries, so recovery from a failed build is rebuild, never patch.
 */
export async function batch(
  docs: docs_v1.Docs,
  documentId: string,
  requests: docs_v1.Schema$Request[],
): Promise<void> {
  for (let i = 0; i < requests.length; i += MAX_REQUESTS_PER_BATCH) {
    const chunk = requests.slice(i, i + MAX_REQUESTS_PER_BATCH)
    if (chunk.length === 0) continue
    await docs.documents.batchUpdate({ documentId, requestBody: { requests: chunk } })
  }
}

/**
 * M0's build: create a document, theme it, and lay down a few named-style paragraphs. This is phases
 * 1 and 2 of the four-phase sequence; readback (3) and range styling (4) arrive with real content.
 */
export async function createThemedDocument(
  auth: AuthProvider,
  opts: { title: string; theme: Theme; blocks: TextBlock[] },
): Promise<BuiltDoc> {
  assertVerifiedFonts(opts.theme)

  const docs = await docsFor(auth)
  const created = await docs.documents.create({ requestBody: { title: opts.title } })
  const documentId = created.data.documentId
  if (!documentId) throw new Error('documents.create returned no documentId')

  // Phase 1: theme first, so text inserted afterwards inherits it instead of needing a restyle pass.
  await batch(docs, documentId, [
    documentStyleRequest(opts.theme),
    ...namedStyleRequests(opts.theme),
  ])

  // Phase 2: the text itself.
  await batch(docs, documentId, renderTextBlocks(opts.blocks, opts.theme).requests)

  return { documentId, url: docsUrl(documentId) }
}

/** Google's own hard cap — addDocumentTab rejects anything longer with a 400. A chapter's title comes
 * from its source H1 and can run well past that, so truncation happens only here, at the tab-strip
 * label; the cover's TOC keeps the full, untruncated title as its link text. */
const MAX_TAB_TITLE_LENGTH = 50

export function tabTitle(title: string): string {
  if (title.length <= MAX_TAB_TITLE_LENGTH) return title
  const truncated = title.slice(0, MAX_TAB_TITLE_LENGTH - 1)
  const lastSpace = truncated.lastIndexOf(' ')
  const base = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated
  return `${base}…`
}

/**
 * Phase 0: a cover tab plus one tab per chapter. A new document already has exactly one tab ("Tab 1",
 * id known from `documents.create`'s own response — no readback needed) — verified live: adding a tab
 * on top of it leaves that stray empty tab sitting in the document, so the cover renames it rather
 * than adding alongside it. Every chapter gets a real `addDocumentTab` call. All requests go in ONE
 * batch, and both reply kinds carry what's needed directly (`addDocumentTab`'s reply includes the new
 * tab's id; the rename's reply is empty, which is fine — we already know that id) — no readback
 * needed here either, which is what keeps chapter count from costing an extra round trip.
 */
async function createTabs(
  docs: docs_v1.Docs,
  documentId: string,
  chapters: Chapter[],
  initialTabId: string,
): Promise<{ coverTabId: string; chapterTabIds: string[] }> {
  const requests: docs_v1.Schema$Request[] = [
    {
      updateDocumentTabProperties: {
        tabProperties: { tabId: initialTabId, title: 'Contents' },
        fields: 'title',
      },
    },
    ...chapters.map((chapter): docs_v1.Schema$Request => ({
      addDocumentTab: { tabProperties: { title: tabTitle(chapter.title) } },
    })),
  ]

  const res = await docs.documents.batchUpdate({ documentId, requestBody: { requests } })
  const replies = res.data.replies ?? []

  const chapterTabIds = chapters.map((_, i) => {
    const tabId = replies[i + 1]?.addDocumentTab?.tabProperties?.tabId
    if (!tabId) throw new Error(`addDocumentTab for chapter ${i} returned no tabId`)
    return tabId
  })

  return { coverTabId: initialTabId, chapterTabIds }
}

/**
 * The real build: a cover tab (title + a clickable, hand-built table of contents) plus one tab per
 * chapter, in document order.
 *
 * The four-phase sequence, exercised for real (M3 forced it per-tab; this is the same shape, just
 * once per chapter instead of once for the whole plan) — PLUS a second readback taken between the
 * non-length-changing style pass and the length-changing one, not after both: a chapter's H1 doesn't
 * get a Docs-assigned `headingId` until HEADING_1 has actually been applied (that's the earlier,
 * non-length-changing pass), and both the cover's TOC and a table cell's own in-body chapter link
 * need that id before they can resolve — a table cell's link specifically can't wait any longer than
 * that, since its own [fill, style] can never be split across two requests. Two readbacks total, not
 * a loop over N: this scales with build phases, not with chapter count.
 *
 * Every chapter's (and the cover's) inserts land in ONE combined phase-2 batch, and each of the two
 * readbacks (covering every tab at once, via includeTabsContent) feeds every chapter's next phase —
 * not one readback per chapter. Only tab creation (phase 0) is inherently sequential ahead of
 * everything else, since a chapter's own tabId has to exist before anything can be inserted into it.
 */
export async function buildFromPlan(
  auth: AuthProvider,
  opts: { theme: Theme; plan: DocPlan },
): Promise<BuiltDoc> {
  assertVerifiedFonts(opts.theme)

  const docs = await docsFor(auth)
  const created = await docs.documents.create({ requestBody: { title: opts.plan.title } })
  const documentId = created.data.documentId
  if (!documentId) throw new Error('documents.create returned no documentId')
  const initialTabId = created.data.tabs?.[0]?.tabProperties?.tabId
  if (!initialTabId) throw new Error('documents.create returned no initial tab')

  // Phase 0: cover tab (renaming the document's existing initial tab) + one tab per chapter.
  const { coverTabId, chapterTabIds } = await createTabs(docs, documentId, opts.plan.chapters, initialTabId)

  const inserts = opts.plan.chapters.map((chapter, i) =>
    compileChapterInserts(opts.theme, chapter, chapterTabIds[i]!),
  )
  const coverEntries = opts.plan.chapters.map((chapter, i) => ({
    title: chapter.title,
    tabId: chapterTabIds[i]!,
  }))

  // Phase 1: theme first, so text inserted afterwards inherits it instead of needing a restyle pass.
  await batch(docs, documentId, [
    documentStyleRequest(opts.theme, coverTabId),
    ...namedStyleRequests(opts.theme, coverTabId),
    ...inserts.flatMap((c) => c.themeRequests),
  ])
  // Phase 2: every chapter's (and the cover's) raw content, chained via endOfSegmentLocation within
  // its own tab.
  await batch(docs, documentId, [
    coverInsertRequest(opts.plan.title, coverEntries, opts.theme, coverTabId),
    ...inserts.flatMap((c) => c.insertRequests),
  ])

  // Phase 3: one readback covering every tab — the index source of truth for everything from here on.
  const doc1 = await fetchDocument(auth, documentId)
  const contents = opts.plan.chapters.map((_, i) =>
    compileChapterContentRequests(doc1, chapterTabIds[i]!, inserts[i]!.segments, opts.theme),
  )
  const coverFirstParagraph = tabBody(doc1, coverTabId)?.content?.find((e) => e.paragraph)
  const coverRealStart = coverFirstParagraph?.startIndex
  if (coverRealStart == null) throw new Error('cover tab has no paragraph in the readback')
  const cover = coverContentStyleRequests(opts.plan.title, coverEntries, opts.theme, coverTabId, coverRealStart)

  await batch(docs, documentId, [...contents.flatMap((c) => c.contentRequests), ...cover.requests])

  // Phase 4/5: a second readback, now that every chapter's H1 has actually been styled HEADING_1 and
  // Docs has assigned it a headingId — nothing before phase 3's own batch landed could have
  // discovered it. Taken BEFORE the length-changing pass, not after: a table cell's own chapter link
  // can only resolve inside its own [fill, style] unit (see compileChapterLengthChangingRequests), so
  // headings must already be known by the time that pass runs, not merely by the time it's over.
  // Cell positions haven't moved since phase 3 touched nothing length-changing, so this same readback
  // serves both purposes.
  const doc2 = await fetchDocument(auth, documentId)
  const headings = chapterTabIds.map((tabId) => {
    const h1 = tabBody(doc2, tabId)?.content?.find(
      (e) => e.paragraph?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    const headingId = h1?.paragraph?.paragraphStyle?.headingId
    if (!headingId) throw new Error(`chapter tab ${tabId} has no HEADING_1 with an assigned headingId`)
    return { tabId, headingId }
  })

  // Phase 6: bullets and table cell fills (now heading-aware, so a cell's own chapter link resolves
  // to Link.heading in the same request as its fill), strictly descending WITHIN each tab — the only
  // requests in this build that change document length, and therefore the only ones for which order
  // matters. Different tabs never interact (a Range's index is only ever meaningful within its own
  // tab), so concatenating tabs in any order here is safe.
  const lengthChanging = opts.plan.chapters.flatMap((_, i) =>
    compileChapterLengthChangingRequests(doc2, chapterTabIds[i]!, inserts[i]!.segments, opts.theme, headings),
  )
  await batch(docs, documentId, lengthChanging)

  // Phase 7: the links that were safe to defer — the table of contents' entries, plus any ordinary
  // in-body (non-table-cell) link that plan/'s planDocument resolved to a sibling chapter. Their
  // ranges came from phase 3's own readback and are still valid: nothing after phase 3 changes the
  // length of already-inserted paragraph text, only phase 6's own table/bullet content.
  const bodyChapterLinks = contents.flatMap((c) => c.chapterLinkRanges)
  await batch(docs, documentId, headingLinkRequests([...cover.entryRanges, ...bodyChapterLinks], headings))

  return { documentId, url: docsUrl(documentId) }
}
