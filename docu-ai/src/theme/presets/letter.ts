import type { Theme } from '../types.js'

/**
 * A cover letter, or any one-page business letter.
 *
 * Added because the first answer was the résumé look, and a real letter built in it came out cramped and
 * top-heavy (found 2026-10-15): 10pt type with 4pt between paragraphs, a 22pt name over a page that was
 * 60% empty. A CV is scanned, so it is packed; a letter is read, so it needs room. The three differences:
 *
 * 1. **Letter proportions.** Inch-wide side margins, 10.5pt body at 115% line spacing, which is how a letter is
 *    set elsewhere; the résumé's 44/50pt margins and 10pt type are for fitting more. Measured on a real
 *    330-word letter: at 11pt its two-line closing spilled onto a second page even with 60pt top and bottom
 *    margins, and at 10.5pt the whole letter sits on one page with room to spare.
 * 2. **Space between the blocks.** A letter is a stack of short blocks — sender, recipient, salutation, each
 *    paragraph, the closing — and the gaps between them are what make it read as a letter. 10pt below every
 *    paragraph does that; the lines inside a block (an address) are joined by a hard break in the source and
 *    stay tight.
 * 3. **A modest name.** The `# heading` is the sender's name, as the résumé's is, but a letterhead is not a
 *    title: 17pt, not 22, and not a shouting banner over the first paragraph.
 *
 * `heading2` and `heading3` exist because a theme must define them, not because a letter uses them; they are
 * kept small so a stray one looks deliberate. Same Inter and Source Serif Pro pairing as the other looks, both in
 * VERIFIED_FONTS.
 */
export const letter: Theme = {
  name: 'letter',
  page: {
    widthPt: 612,
    heightPt: 792,
    // 72pt at the sides, where the line length is set; 60pt top and bottom (see the comment above).
    marginTopPt: 60,
    marginBottomPt: 60,
    marginLeftPt: 72,
    marginRightPt: 72,
  },
  // TITLE and SUBTITLE are required by Theme and unused: the sender's name is an H1, which gets a headingId.
  title: {
    text: { font: 'Inter', sizePt: 17, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 0, spaceBelowPt: 6, lineSpacingPct: 100, alignment: 'START', indentEndPt: 0 },
  },
  subtitle: {
    text: { font: 'Source Serif Pro', sizePt: 11, italic: true, color: '#5f6368' },
    para: { spaceAbovePt: 0, spaceBelowPt: 10, lineSpacingPct: 115, alignment: 'START', indentEndPt: 0 },
  },
  heading1: {
    text: { font: 'Inter', sizePt: 17, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 0, spaceBelowPt: 6, lineSpacingPct: 100, alignment: 'START', indentEndPt: 0 },
  },
  heading2: {
    text: { font: 'Inter', sizePt: 12, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 6, spaceBelowPt: 6, lineSpacingPct: 100, keepWithNext: true, alignment: 'START', indentEndPt: 0 },
  },
  heading3: {
    text: { font: 'Inter', sizePt: 11, bold: true, color: '#3c4043' },
    para: { spaceAbovePt: 4, spaceBelowPt: 4, lineSpacingPct: 100, keepWithNext: true, alignment: 'START', indentEndPt: 0 },
  },
  body: {
    text: { font: 'Source Serif Pro', sizePt: 10.5, color: '#202124' },
    para: { spaceAbovePt: 0, spaceBelowPt: 10, lineSpacingPct: 115, alignment: 'START', indentEndPt: 0 },
  },
  code: { font: 'Roboto Mono', sizePt: 10, color: '#3c4043', backgroundColor: '#f1f3f4' },
  rule: { color: '#dadce0', widthPt: 0.75, spaceAbovePt: 6, spaceBelowPt: 10 },
  // Defined because the theme contract requires them; a letter has no business containing a fenced block,
  // a quotation set off at length, or a table.
  codeBlock: {
    text: { font: 'Roboto Mono', sizePt: 10, color: '#202124' },
    shading: '#f8f9fa',
    borderColor: '#dadce0',
    borderWidthPt: 1,
    paddingPt: 5,
    spaceAbovePt: 8,
    spaceBelowPt: 8,
  },
  blockquote: { borderColor: '#80868b', borderWidthPt: 2, paddingPt: 6 },
  table: { headerShading: '#e8eaed' },
}
