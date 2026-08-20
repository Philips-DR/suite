import type { Theme } from '../types.js'

/**
 * Every font here is in VERIFIED_FONTS, meaning `npm run probe` saw it embedded in a PDF export.
 * Source Serif Pro for reading, Inter for structure — a serif body with a sans hierarchy is the
 * conventional technical-report pairing and keeps headings distinct at a glance.
 */
export const technical: Theme = {
  name: 'technical',
  page: {
    // 54pt (0.75in) rather than the usual 72pt, on evidence: the real corpus has 95-character code
    // lines, and a 72pt+ margin cannot fit those at a readable monospace size. See
    // test/fixtures/README.md. 54pt gives a ~504pt column: 95 chars at ~8.8pt.
    marginTopPt: 60,
    marginBottomPt: 60,
    marginLeftPt: 54,
    marginRightPt: 54,
  },
  // Every prose style below carries the same indentEndPt: 72 — a 504pt page column read at ~92
  // characters/line, well past the 65–75 that prose is comfortable at (confirmed on the M0 render).
  // Code blocks explicitly zero this back out, so they read deliberately wider than the text around
  // them — the width the 95-character lines in the corpus actually need. See test/fixtures/README.md.
  title: {
    text: { font: 'Inter', sizePt: 26, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 0, spaceBelowPt: 6, lineSpacingPct: 100, alignment: 'START', indentEndPt: 72 },
  },
  subtitle: {
    text: { font: 'Source Serif Pro', sizePt: 14, italic: true, color: '#5f6368' },
    para: { spaceAbovePt: 0, spaceBelowPt: 24, lineSpacingPct: 100, alignment: 'START', indentEndPt: 72 },
  },
  heading1: {
    text: { font: 'Inter', sizePt: 19, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 24, spaceBelowPt: 8, lineSpacingPct: 100, keepWithNext: true, indentEndPt: 72 },
  },
  heading2: {
    text: { font: 'Inter', sizePt: 15, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 18, spaceBelowPt: 6, lineSpacingPct: 100, keepWithNext: true, indentEndPt: 72 },
  },
  heading3: {
    text: { font: 'Inter', sizePt: 12.5, bold: true, color: '#3c4043' },
    para: { spaceAbovePt: 14, spaceBelowPt: 4, lineSpacingPct: 100, keepWithNext: true, indentEndPt: 72 },
  },
  body: {
    text: { font: 'Source Serif Pro', sizePt: 11, color: '#202124' },
    para: { spaceAbovePt: 0, spaceBelowPt: 10, lineSpacingPct: 115, alignment: 'START', indentEndPt: 72 },
  },
  // Slightly smaller than body and set in mono, on a light neutral chip — a common, unobtrusive
  // convention for inline code that stays legible sitting inside a line of running prose.
  code: { font: 'Roboto Mono', sizePt: 10, color: '#3c4043', backgroundColor: '#f1f3f4' },
  rule: { color: '#dadce0', widthPt: 1, spaceAbovePt: 12, spaceBelowPt: 12 },
  // A fenced block is ONE paragraph (lines joined by \v), so this shading/border covers the whole
  // block once — no per-line gaps. Lighter shading than inline code's chip (#f8f9fa vs #f1f3f4):
  // a whole page of code shaded as heavily as a short inline span would read as too heavy.
  codeBlock: {
    text: { font: 'Roboto Mono', sizePt: 10, color: '#202124' },
    shading: '#f8f9fa',
    borderColor: '#dadce0',
    borderWidthPt: 1,
    paddingPt: 6,
    spaceAbovePt: 12,
    spaceBelowPt: 12,
  },
  blockquote: { borderColor: '#80868b', borderWidthPt: 2, paddingPt: 6 },
  // A step darker than the rule/code-block grays (#dadce0/#f8f9fa) so the header row reads as
  // structurally distinct at a glance, not just another shaded block.
  table: { headerShading: '#e8eaed' },
}
