/**
 * A deterministic stand-in for the LLM-based detector plan.md earmarks for this seam. Runs only
 * when a fence has no language tag — most of this project's real corpus (see
 * test/fixtures/README.md: 9 of 10 fences in the M1/M2 fixture set are untagged, and most of those
 * turn out to be ASCII flow diagrams, not code in any language at all). Returning undefined for
 * genuinely unidentifiable content is the correct answer, not a failure — it must never guess.
 */

interface Signature {
  lang: string
  test: (code: string) => boolean
}

const SIGNATURES: Signature[] = [
  { lang: 'python', test: (c) => /^\s*(def|class)\s+\w+.*:\s*$/m.test(c) || /^\s*(import|from)\s+\w+/m.test(c) },
  { lang: 'yaml', test: (c) => /^---\s*$/m.test(c) || /^[\w.-]+:\s*(\S.*)?$/m.test(c) && !/[{};]/.test(c) },
  { lang: 'json', test: (c) => /^\s*[[{]/.test(c.trim()) && /"[\w-]+"\s*:/.test(c) },
  { lang: 'sql', test: (c) => /\b(select|insert|update|delete)\b[\s\S]*\bfrom\b/i.test(c) },
  { lang: 'dockerfile', test: (c) => /^\s*(FROM|RUN|COPY|WORKDIR|ENTRYPOINT|CMD)\b/m.test(c) },
  { lang: 'bash', test: (c) => /^#!.*\b(bash|sh)\b/.test(c) || /^\s*\$\s+\S/m.test(c) },
  {
    lang: 'javascript',
    test: (c) => /\b(const|let|function)\s+\w+/.test(c) && /=>|;\s*$/m.test(c),
  },
]

export function detectLanguage(code: string): string | undefined {
  return SIGNATURES.find((sig) => sig.test(code))?.lang
}
