import { google, type docs_v1 } from 'googleapis'
import type { AuthProvider } from '../auth/types.js'
import type { DocPlan } from '../plan/types.js'
import { assertVerifiedFonts } from '../theme/fonts.js'
import type { Theme } from '../theme/types.js'
import { compileDocument } from './compile.js'
import { documentStyleRequest, namedStyleRequests } from './namedStyles.js'
import { renderTextBlocks, type TextBlock } from './text.js'

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

/**
 * The real M1 build: every chapter's blocks, concatenated into one tab (multi-tab arrives in M4),
 * separated by a rule so chapter boundaries stay visible in the meantime.
 *
 * No readback is needed here, unlike the general four-phase sequence: everything in M1 fits inside a
 * single insert pass with one exactly-known length-changing step (bullets) applied last, so the
 * insert-time cursor stays valid throughout. M2's fenced-code blocks and M3's `insertTable`
 * placeholders are what will force a real readback between insert and style.
 */
export async function buildFromPlan(
  auth: AuthProvider,
  opts: { theme: Theme; plan: DocPlan },
): Promise<BuiltDoc> {
  assertVerifiedFonts(opts.theme)
  const compiled = compileDocument(opts.theme, opts.plan)

  const docs = await docsFor(auth)
  const created = await docs.documents.create({ requestBody: { title: opts.plan.title } })
  const documentId = created.data.documentId
  if (!documentId) throw new Error('documents.create returned no documentId')

  await batch(docs, documentId, compiled.themeRequests)
  await batch(docs, documentId, compiled.contentRequests)
  // Bullets last and strictly descending — the only requests in this build that change document
  // length, and therefore the only ones for which order matters.
  await batch(docs, documentId, compiled.bulletRequests)

  return { documentId, url: docsUrl(documentId) }
}
