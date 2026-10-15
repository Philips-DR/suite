import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { docs_v1 } from 'googleapis'
import type { AuthProvider } from '../auth/types.js'
import { exportPdf } from './pdfFonts.js'
import { bodies, fetchDocument } from './readback.js'

const run = promisify(execFile)

/**
 * What the readback cannot see, because it is decided when Docs lays the page out: how many pages the
 * document is, and whether a page break fell where it hurts. A stored `keepWithNext` is not proof of a
 * kept pair — the same lesson as fonts and `indentStart` (CLAUDE.md) — so this reads the PDF Docs
 * exports, which is the only place a page break exists.
 *
 * The analysis is a pure function of the pages' text and the document's paragraphs, so it is tested
 * with no network. Only `measureLayout` does I/O (export, `pdftotext`, one readback).
 */

export interface LayoutParagraph {
  text: string
  /** `lead` is a body paragraph directly under a heading: a role's dates, a project's stack line. */
  role: 'heading' | 'lead' | 'bullet' | 'body'
  /** A heading's rank: 1 is the biggest. Set on headings only. */
  level?: number
}

export type LayoutResult =
  | { measured: true; pages: number; lastPageLines: number; warnings: string[] }
  | { measured: false; reason: string }

export interface LayoutOptions {
  /** A page count the caller wants to stay within; going over is a warning, not an error. */
  maxPages?: number
}

/** The last page holding this few lines or fewer is a spill, not a page someone meant to write. */
export const SHORT_LAST_PAGE_LINES = 5

/** How many lines at the foot of a page can belong to one heading and its lead line. */
const FOOT_LINES = 8

const squash = (text: string): string => text.normalize('NFKC').replace(/[\s\u00ad\u200b]+/g, '')

/** A page's lines: non-empty, with the form feed and bullet-glyph-only lines gone. */
function linesOf(page: string): string[] {
  return page
    .split('\n')
    .map((line) => line.replace(/\f/g, '').trim())
    .filter((line) => line.length > 0)
}

/**
 * The groups that must not be split from what follows them: every heading alone, and a heading with
 * its lead line. A page that ENDS with one of these has stranded it — its content is on the next page.
 */
function keepGroups(paragraphs: LayoutParagraph[]): Array<{ squashed: string; label: string }> {
  const groups: Array<{ squashed: string; label: string }> = []
  paragraphs.forEach((p, i) => {
    if (p.role !== 'heading') return
    groups.push({ squashed: squash(p.text), label: p.text })
    const lead = paragraphs[i + 1]
    const after = paragraphs[i + 2]
    // A lead followed by a heading of the same or a higher rank is the whole entry (an education line):
    // ending a page there strands nothing. Same rule as emit/blocks.ts, which does not keep it either.
    const completes = after?.role === 'heading' && (after.level ?? 0) <= (p.level ?? 0)
    if (lead?.role === 'lead' && after !== undefined && !completes) {
      groups.push({ squashed: squash(p.text + lead.text), label: `${p.text} / ${lead.text}` })
    }
  })
  return groups.filter((g) => g.squashed.length > 0)
}

/**
 * Pure. `pages` is the exported PDF's text, one string per page. Findings, in order:
 *  - a heading (or a heading with its lead line) ends a page that is not the last: stranded;
 *  - more pages than `maxPages`;
 *  - a last page of only a few lines, when the document runs to more than one page.
 */
export function layoutFindings(
  pages: string[],
  paragraphs: LayoutParagraph[],
  opts: LayoutOptions = {},
): Extract<LayoutResult, { measured: true }> {
  const warnings: string[] = []
  const groups = keepGroups(paragraphs)

  pages.slice(0, -1).forEach((page, i) => {
    const lines = linesOf(page)
    for (let k = 1; k <= Math.min(FOOT_LINES, lines.length); k++) {
      // Whole lines only, from a line boundary: a bullet that merely ends in the word "Skills" must
      // not read as the "Skills" heading.
      const tail = squash(lines.slice(-k).join(' '))
      const hit = groups.find((g) => g.squashed === tail)
      if (hit) {
        warnings.push(
          `Page ${i + 1} ends with "${hit.label}", and what it introduces starts on page ${i + 2}. ` +
            'Shorten the text before it so the whole block moves up, or add a little so it moves down.',
        )
        break
      }
    }
  })

  const lastPageLines = linesOf(pages[pages.length - 1] ?? '').length
  if (opts.maxPages !== undefined && pages.length > opts.maxPages) {
    warnings.push(
      `The document is ${pages.length} pages; the target is ${opts.maxPages}. ` +
        `The last page holds ${lastPageLines} lines. Cut text (the least relevant points first) and rebuild.`,
    )
  } else if (pages.length > 1 && lastPageLines <= SHORT_LAST_PAGE_LINES) {
    warnings.push(
      `The last page holds only ${lastPageLines} lines. Trim a few lines to fit on ${pages.length - 1} ` +
        `page${pages.length - 1 === 1 ? '' : 's'}, or add enough that it is not a stray spill.`,
    )
  }

  return { measured: true, pages: pages.length, lastPageLines, warnings }
}

/** The document's paragraphs, in order, as `layoutFindings` wants them. Empty paragraphs are dropped. */
export function layoutParagraphs(doc: docs_v1.Schema$Document): LayoutParagraph[] {
  const out: LayoutParagraph[] = []
  for (const body of bodies(doc)) {
    for (const element of body.content ?? []) {
      const paragraph = element.paragraph
      if (!paragraph) continue
      const text = (paragraph.elements ?? [])
        .map((e) => e.textRun?.content ?? '')
        .join('')
        .replace(/[\n\v]+/g, ' ')
        .trim()
      if (text.length === 0) continue
      const style = paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT'
      const previous = out[out.length - 1]
      const isHeading = style.startsWith('HEADING_') || style === 'TITLE'
      const role: LayoutParagraph['role'] = isHeading
        ? 'heading'
        : paragraph.bullet
          ? 'bullet'
          : previous?.role === 'heading'
            ? 'lead'
            : 'body'
      // TITLE ranks above HEADING_1.
      out.push(isHeading ? { text, role, level: style === 'TITLE' ? 0 : Number(style.slice('HEADING_'.length)) } : { text, role })
    }
  }
  return out
}

/** One document tab means the PDF's pages are the document's pages; see `measureLayout`. */
export function tabCount(doc: docs_v1.Schema$Document): number {
  const count = (tabs: docs_v1.Schema$Tab[] | undefined): number =>
    (tabs ?? []).reduce((n, tab) => n + 1 + count(tab.childTabs), 0)
  return doc.tabs ? count(doc.tabs) : 1
}

/** Each page's text, in reading order, from a PDF on disk. Needs `pdftotext` (poppler-utils). */
export async function pdfPageTexts(pdfPath: string): Promise<string[]> {
  const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], { maxBuffer: 64 * 1024 * 1024 })
  // pdftotext ends every page, the last included, with a form feed.
  const pages = stdout.split('\f')
  if (pages[pages.length - 1]?.trim() === '') pages.pop()
  return pages
}

/**
 * Export the document as the PDF Docs itself lays out, and look at where its pages break.
 *
 * Never throws for a reason that is not the document's: a machine without `pdftotext`, or a failed
 * export, comes back as `measured: false` with the reason, so a build that worked is still a build
 * that worked — it just says it could not be measured, rather than saying nothing or failing.
 *
 * A document of more than one tab is not measured: Docs' PDF export puts a title page in front of
 * every tab (CLAUDE.md, M4), so its page count is not what a reader scrolls through.
 */
export async function measureLayout(
  auth: AuthProvider,
  documentId: string,
  opts: LayoutOptions & { doc?: docs_v1.Schema$Document } = {},
): Promise<LayoutResult> {
  let directory: string | undefined
  try {
    const doc = opts.doc ?? (await fetchDocument(auth, documentId))
    if (tabCount(doc) > 1) {
      return {
        measured: false,
        reason: "a document of several tabs is not measured: Docs' PDF export adds a title page per tab",
      }
    }
    directory = await mkdtemp(join(tmpdir(), 'docu-ai-layout-'))
    const pdfPath = await exportPdf(auth, documentId, join(directory, 'document.pdf'))
    const pages = await pdfPageTexts(pdfPath)
    if (pages.length === 0) return { measured: false, reason: 'the exported PDF has no pages' }
    return layoutFindings(pages, layoutParagraphs(doc), opts)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const missing = /ENOENT/.test(message) && /pdftotext/.test(message)
    return {
      measured: false,
      reason: missing
        ? 'pdftotext is not installed (poppler-utils), so the page layout could not be read'
        : `the layout could not be measured: ${message.slice(0, 200)}`,
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
