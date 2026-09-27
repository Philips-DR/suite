/**
 * Applied to plain prose text only — never to inline code, fenced code, or anything else that must
 * survive byte-for-byte. Turning a straight quote inside a code span into a curly one would be a
 * correctness bug, not a nicety.
 */

// mdast keeps a markdown soft wrap as a literal "\n" inside a text node's value (verified against a
// live parse, not assumed). It is not a line break, hard or soft — it is mid-sentence wrapping in the
// source file and must become a plain space so the paragraph flows.
export function collapseSoftWraps(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}

export function smartenPunctuation(text: string): string {
  let out = text

  // Ellipsis first, so "..." is never mistaken for a run of dashes.
  out = out.replace(/\.\.\./g, '…')

  // Em dash: "word--word", "word -- word", or "word - word". En dash: a numeric range like "3-5".
  out = out.replace(/(\S) -- (\S)/g, `$1—$2`)
  out = out.replace(/(\w)--(\w)/g, `$1—$2`)
  out = out.replace(/(\S) - (\S)/g, `$1—$2`)
  out = out.replace(/(\d)-(\d)/g, `$1–$2`)

  out = out.replace(/"([^"]*)"/g, `“$1”`)

  // Single quotes and apostrophes share one glyph (’) whenever they close or sit inside a word —
  // "don't", "Google's", and a closing quote after a word are all indistinguishable typographically.
  // Only a mark that opens a quoted phrase needs the other glyph, so that is the one case singled
  // out: not preceded by a letter/digit, but followed by one. (A decade elision like `'90s` reads as
  // an open quote here rather than the ’90s convention — a known, accepted miss for a prose pass.)
  out = out.replace(/(?<=[\p{L}\p{N}])'/gu, '’')
  out = out.replace(/'(?=[\p{L}\p{N}])/gu, '‘')
  out = out.replace(/'/g, '’')

  return out
}

export function typeset(text: string): string {
  return smartenPunctuation(collapseSoftWraps(text))
}
