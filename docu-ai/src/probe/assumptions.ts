import { writeFile } from 'node:fs/promises'
import type { docs_v1 } from 'googleapis'
import type { AuthProvider } from '../auth/types.js'
import { batch, docsFor, docsUrl } from '../emit/document.js'
import { documentStyleRequest, namedStyleRequests } from '../emit/namedStyles.js'
import { renderTextBlocks, type TextBlock } from '../emit/text.js'
import { plain } from '../plan/types.js'
import { FONT_CANDIDATES } from '../theme/fonts.js'
import { technical } from '../theme/presets/technical.js'
import { exportPdf, pdfFontNames, verdictFor, type FontVerdict } from '../verify/pdfFonts.js'
import { describeRuns, fetchDocument } from '../verify/readback.js'

/**
 * A diagnostic, not part of the build — which is why it lives outside emit/ and verify/ and is
 * allowed to do its own I/O.
 *
 * It answers the questions the discovery document cannot: schema presence is not proof an endpoint
 * behaves, and a stored font is not proof of a rendered one.
 */

const LINE_BREAK_MARKER = 'linebreakprobe'

export interface ProbeReport {
  documentId: string
  documentUrl: string
  fonts: FontVerdict[]
  embeddedFonts: string[]
  controls: { positiveApplied: boolean; negativeFellBack: boolean; trustworthy: boolean }
  tabs: { supported: boolean; titles: string[]; error?: string }
  verticalTabLineBreak: { supported: boolean; detail: string }
  fieldMaskDialects: { snakeCase: boolean; camelCase: boolean; camelCaseError?: string }
}

export async function probeAssumptions(auth: AuthProvider, pdfPath: string): Promise<ProbeReport> {
  const docs = await docsFor(auth)
  const created = await docs.documents.create({ requestBody: { title: 'docu-ai — assumption probe' } })
  const documentId = created.data.documentId
  if (!documentId) throw new Error('documents.create returned no documentId')

  // ---- 1. Theme, using snake_case field masks. A bad mask fails loudly, so reaching the next step
  //         is itself the evidence that the dialect is accepted.
  let snakeCase = true
  try {
    await batch(docs, documentId, [documentStyleRequest(technical), ...namedStyleRequests(technical)])
  } catch (err) {
    snakeCase = false
    throw new Error(`snake_case field masks were rejected, which blocks everything else: ${String(err)}`)
  }

  // ---- 2. One paragraph per candidate font, plus a \v line-break specimen.
  const blocks: TextBlock[] = FONT_CANDIDATES.map((candidate) => ({
    runs: plain(`${candidate.family} — Sphinx of black quartz, judge my vow 0123`),
    style: 'NORMAL_TEXT' as const,
  }))
  blocks.push({ runs: plain(`${LINE_BREAK_MARKER}-alpha\v${LINE_BREAK_MARKER}-beta`), style: 'NORMAL_TEXT' })

  const rendered = renderTextBlocks(blocks, technical)
  const fontRequests: docs_v1.Schema$Request[] = FONT_CANDIDATES.map((candidate, i) => ({
    updateTextStyle: {
      range: rendered.ranges[i],
      textStyle: { weightedFontFamily: { fontFamily: candidate.family } },
      fields: 'weighted_font_family',
    },
  }))
  await batch(docs, documentId, [...rendered.requests, ...fontRequests])

  // ---- 3. Does addDocumentTab actually work? Verified in the schema, never yet exercised.
  const tabs: ProbeReport['tabs'] = { supported: false, titles: [] }
  try {
    await batch(docs, documentId, [
      { addDocumentTab: { tabProperties: { title: 'Chapter 2', iconEmoji: '📘' } } },
    ])
    tabs.supported = true
  } catch (err) {
    tabs.error = String(err)
  }

  // ---- 4. Is a camelCase field mask also accepted? Nice to know; not something we rely on.
  let camelCase = true
  let camelCaseError: string | undefined
  try {
    await batch(docs, documentId, [
      {
        updateNamedStyle: {
          namedStyle: { namedStyleType: 'HEADING_6', textStyle: { bold: true } },
          fields: 'namedStyleType,textStyle.bold',
        },
      },
    ])
  } catch (err) {
    camelCase = false
    camelCaseError = String(err)
  }

  // ---- 5. Read back, then export and inspect what the renderer really used.
  const doc = await fetchDocument(auth, documentId)
  if (tabs.supported) {
    tabs.titles = (doc.tabs ?? []).map((tab) => tab.tabProperties?.title ?? '(untitled)')
  }

  const runs = describeRuns(doc)
  const breakRun = runs.find((run) => run.text.includes(LINE_BREAK_MARKER))
  const verticalTabLineBreak = breakRun
    ? {
        supported: breakRun.text.includes('\v'),
        detail: breakRun.text.includes('\v')
          ? 'survived as \\v inside a single text run — a line break, not a paragraph split'
          : `came back as ${JSON.stringify(breakRun.text)}; \\v did not survive`,
      }
    : { supported: false, detail: 'line-break specimen not found in readback' }

  await exportPdf(auth, documentId, pdfPath)
  const embeddedFonts = await pdfFontNames(pdfPath)
  const fonts = FONT_CANDIDATES.map((candidate) => verdictFor(candidate.family, embeddedFonts))

  // The controls decide whether any of the above means anything.
  const positiveApplied = fonts.find((f) => f.requested === 'Arial')?.applied ?? false
  const negative = fonts.find((f) => f.requested.startsWith('Zzyzx'))
  const negativeFellBack = negative ? !negative.applied : false

  return {
    documentId,
    documentUrl: docsUrl(documentId),
    fonts,
    embeddedFonts,
    controls: {
      positiveApplied,
      negativeFellBack,
      trustworthy: positiveApplied && negativeFellBack,
    },
    tabs,
    verticalTabLineBreak,
    fieldMaskDialects: { snakeCase, camelCase, ...(camelCaseError ? { camelCaseError } : {}) },
  }
}

export function formatReport(report: ProbeReport, doc: { paragraphs: number }): string {
  const lines: string[] = []
  const tick = (ok: boolean): string => (ok ? 'yes' : 'NO')

  lines.push('', `document:   ${report.documentUrl}`, `paragraphs: ${doc.paragraphs}`, '')

  lines.push('CONTROLS — if these are wrong, ignore every font result below')
  lines.push(`  Arial embedded (positive):        ${tick(report.controls.positiveApplied)}`)
  lines.push(`  fake font fell back (negative):   ${tick(report.controls.negativeFellBack)}`)
  lines.push(`  => font results trustworthy:      ${tick(report.controls.trustworthy)}`, '')

  lines.push('FONTS')
  for (const verdict of report.fonts) {
    const matched = verdict.matchedAs && verdict.matchedAs !== verdict.requested
    lines.push(
      `  ${verdict.applied ? 'ok  ' : 'FELL BACK'} ${verdict.requested.padEnd(26)}` +
        (matched ? ` (embedded as ${verdict.matchedAs})` : ''),
    )
  }
  lines.push('', `  embedded in PDF: ${report.embeddedFonts.join(', ')}`, '')

  lines.push('OTHER ASSUMPTIONS')
  lines.push(
    `  addDocumentTab works:            ${tick(report.tabs.supported)}` +
      (report.tabs.titles.length > 0 ? ` [${report.tabs.titles.join(', ')}]` : '') +
      (report.tabs.error ? `\n    ${report.tabs.error}` : ''),
  )
  lines.push(
    `  \\v is an in-paragraph break:     ${tick(report.verticalTabLineBreak.supported)}\n` +
      `    ${report.verticalTabLineBreak.detail}`,
  )
  lines.push(`  snake_case field masks:          ${tick(report.fieldMaskDialects.snakeCase)}`)
  lines.push(`  camelCase field masks:           ${tick(report.fieldMaskDialects.camelCase)}`)
  lines.push('')

  const passed = report.fonts.filter((f) => f.applied).map((f) => f.requested)
  lines.push('NEXT: add these to VERIFIED_FONTS in src/theme/fonts.ts (drop the controls):')
  lines.push(`  ${passed.join(', ')}`, '')
  return lines.join('\n')
}

export async function writeReport(report: ProbeReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2))
}
