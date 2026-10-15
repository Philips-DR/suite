import type { Theme } from '../types.js'

/**
 * A one-to-two page résumé, which is a genuinely different document from the technical report the
 * `technical` preset is tuned for, in three ways that all pull the same direction — fit more on the
 * page without making it look crowded:
 *
 * 1. **Full measure, not a narrowed one.** Every prose style in `technical` carries
 *    `indentEndPt: 72`, because 92-character lines of running prose are tiring to read. A résumé is
 *    not running prose — it's scanned, in short bullets, by someone giving it well under a minute —
 *    and surrendering an inch of the right margin costs a line of content per bullet for no gain.
 *    Pinned to 0 explicitly rather than left unset: CLAUDE.md's rule about never relying on
 *    inheritance applies to "inherits the API default" too.
 * 2. **Tighter everything.** 44/50pt margins against `technical`'s 60/54, 10pt body against 11pt,
 *    and single-digit paragraph spacing throughout. Nothing here has to accommodate a 95-character
 *    code line, which is what drove `technical`'s numbers.
 * 3. **Section headings carry a rule.** `heading2` sets `borderBottom`, so every `##` becomes a
 *    ruled section divider with no markdown noise in the source — the author writes a heading, not a
 *    heading followed by a `---`. This is the whole reason ParaBorderSpec exists.
 *
 * The heading levels map onto a résumé's actual structure rather than a report's: `heading1` is the
 * candidate's name (one per document, set once at the top), `heading2` is a section (EXPERIENCE,
 * SKILLS), `heading3` is a single role or project within one. Sizes are chosen so all three stay
 * distinguishable despite being much closer together than a report's 26/19/15/12.5 ramp.
 *
 * Same Inter + Source Serif Pro pairing as `technical`, and for the same reason: both are in
 * VERIFIED_FONTS, meaning `npm run probe` watched them embed in a real PDF export. A résumé is the
 * last document you want silently rendered in Arial.
 */
export const resume: Theme = {
  name: 'resume',
  page: {
    widthPt: 612,
    heightPt: 792,
    // 44/50 rather than technical's 60/54. A résumé is read as a single scan, so the page wants to
    // look full and organised, not airy — and every point of margin here is a point of content.
    marginTopPt: 44,
    marginBottomPt: 44,
    marginLeftPt: 50,
    marginRightPt: 50,
  },
  // TITLE and SUBTITLE are defined because Theme requires them, not because this document uses them:
  // a résumé's name is an H1 (it needs a headingId and an outline entry, which TITLE doesn't give).
  // Kept consistent with heading1 so that a stray TITLE paragraph would look deliberate, not broken.
  title: {
    text: { font: 'Inter', sizePt: 22, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 0, spaceBelowPt: 2, lineSpacingPct: 100, alignment: 'START', indentEndPt: 0 },
  },
  subtitle: {
    text: { font: 'Source Serif Pro', sizePt: 10.5, italic: true, color: '#5f6368' },
    para: { spaceAbovePt: 0, spaceBelowPt: 8, lineSpacingPct: 100, alignment: 'START', indentEndPt: 0 },
  },
  // The name. Deliberately not centred: a left-aligned header block reads as current rather than
  // dated, and — the practical reason — centring only the name and contact line would need
  // per-paragraph alignment overrides the IR has no way to express, since alignment here is a
  // property of a named style and the contact line is an ordinary NORMAL_TEXT paragraph.
  heading1: {
    text: { font: 'Inter', sizePt: 22, bold: true, color: '#1a1a1a' },
    para: { spaceAbovePt: 0, spaceBelowPt: 3, lineSpacingPct: 100, alignment: 'START', indentEndPt: 0 },
  },
  // A section divider: EXPERIENCE, SKILLS, EDUCATION. The rule underneath is what separates this
  // from heading3 at a glance — they're only 1.5pt apart in size, which is as close as two levels can
  // sit while staying legible as a hierarchy, and closer than any size ramp alone could carry.
  heading2: {
    text: { font: 'Inter', sizePt: 12.5, bold: true, color: '#1a1a1a' },
    para: {
      spaceAbovePt: 15,
      spaceBelowPt: 6,
      lineSpacingPct: 100,
      keepWithNext: true,
      alignment: 'START',
      indentEndPt: 0,
      // Mid-grey rather than black: at 0.75pt a black rule under 12.5pt text reads heavier than the
      // heading itself, which inverts the hierarchy it's supposed to reinforce.
      borderBottom: { color: '#9aa0a6', widthPt: 0.75, paddingPt: 3 },
    },
  },
  // One role or project. keepWithNext matters more here than anywhere else in the document: a job
  // title stranded at the foot of page 1 with its bullets on page 2 is the single most common way a
  // résumé's page break goes wrong.
  heading3: {
    text: { font: 'Inter', sizePt: 11, bold: true, color: '#202124' },
    para: { spaceAbovePt: 10, spaceBelowPt: 1, lineSpacingPct: 100, keepWithNext: true, alignment: 'START', indentEndPt: 0 },
  },
  body: {
    text: { font: 'Source Serif Pro', sizePt: 10, color: '#202124' },
    para: { spaceAbovePt: 0, spaceBelowPt: 4, lineSpacingPct: 108, alignment: 'START', indentEndPt: 0 },
  },
  code: { font: 'Roboto Mono', sizePt: 9, color: '#3c4043', backgroundColor: '#f1f3f4' },
  rule: { color: '#dadce0', widthPt: 0.75, spaceAbovePt: 6, spaceBelowPt: 6 },
  // Defined for completeness — a résumé has no business containing a fenced code block, but the
  // theme contract requires the spec and a half-filled one would render worse than a considered one
  // if a source file ever did carry a fence.
  codeBlock: {
    text: { font: 'Roboto Mono', sizePt: 9, color: '#202124' },
    shading: '#f8f9fa',
    borderColor: '#dadce0',
    borderWidthPt: 1,
    paddingPt: 5,
    spaceAbovePt: 8,
    spaceBelowPt: 8,
  },
  blockquote: { borderColor: '#80868b', borderWidthPt: 2, paddingPt: 6 },
  table: { headerShading: '#e8eaed' },
  // The dates line under a role, the stack line under a project, the note under a section heading:
  // kept with what follows, so the heading, its line and the first block move together (the
  // headings' own keepWithNext keeps only the first pair). Not a Summary-style paragraph that is
  // followed by the next section's heading: compileBlocks leaves a lead that ends its entry alone.
  keepLeadWithNext: [2, 3],
}
