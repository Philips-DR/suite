// The Documents page's words that are easy to get quietly wrong: which look a file's name asks for, the line that
// tells two documents of the same name apart, and what a build's page count says. Pure, so they are tested.

export type Look = 'technical' | 'resume' | 'letter'

// A word on its own, not part of another: "My_CV" and "CV - ML Engineer" are CVs, "newsletter" is not a letter.
const word = (w: string) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i')
const LETTER = word('letter')
const CV = word('(cv|resume|résumé)')

/** docu-ai's look for one file, from its name: a letter in the letter look, a CV in the CV look, the rest as a document. */
export function lookFor(name: string): Look {
  if (LETTER.test(name)) return 'letter'
  if (CV.test(name)) return 'resume'
  return 'technical'
}

const sameYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const otherYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** "Made 14 Oct, 12:03", and when it was edited after that, "· edited 6 d ago". */
export function madeLine(
  created: string,
  modified: string,
  ago: (when: string) => string,
  now = Date.now(),
): string {
  const made = new Date(created)
  if (Number.isNaN(made.getTime())) return modified ? `Edited ${ago(modified)}` : ''
  const format = made.getFullYear() === new Date(now).getFullYear() ? sameYear : otherYear
  const line = `Made ${format.format(made)}`
  const edited = new Date(modified).getTime() - made.getTime()
  // Building a Doc edits it for a minute or so after it is made; that is not an edit worth naming.
  return edited > 5 * 60_000 ? `${line} · edited ${ago(modified)}` : line
}

/** How many of these documents share their name with another one. */
export function sharingNames(titles: string[]): number {
  const counts = new Map<string, number>()
  for (const t of titles) counts.set(t.trim().toLowerCase(), (counts.get(t.trim().toLowerCase()) ?? 0) + 1)
  return titles.filter((t) => (counts.get(t.trim().toLowerCase()) ?? 0) > 1).length
}

export type Layout = { measured: true; pages: number; lastPageLines: number; warnings: string[] } | { measured: false; reason: string }

/** The page count as a phrase, or why it was not counted. Never silent: "no warnings" must mean it was looked at. */
export function pagesLine(layout: Layout | undefined): string {
  if (!layout) return 'Pages not counted.'
  if (!layout.measured) return `Pages not counted: ${layout.reason}.`
  return `${layout.pages} page${layout.pages === 1 ? '' : 's'}`
}
