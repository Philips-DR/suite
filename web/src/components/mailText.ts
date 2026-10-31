// What an email's text looks like on the page. mail-ai turns HTML mail into text, and a newsletter's layout
// tables become hundreds of empty lines: one real message was 431 blank lines of 462, with 122 in a row, so
// the page showed "96" and a screen of nothing. Shown, not changed: the stored text is untouched.

// Characters that render as nothing but keep a line from counting as empty (layout padding in HTML mail).
const INVISIBLE = /[ ͏᠎​-‏⁠﻿]/g

/** Lines that hold only spaces or invisible characters become empty; runs of empty lines become one. */
export function cleanBody(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .map((line) => (line.replace(INVISIBLE, '').trim() === '' ? '' : line.replace(/\s+$/, '')))
  const kept: string[] = []
  for (const line of lines) {
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue
    kept.push(line)
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n')
}

/** The opening of a message on one line, for a folded message or a list row: whole words, then "…". */
export function firstWords(text: string, max = 140): string {
  const flat = cleanBody(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`
}
