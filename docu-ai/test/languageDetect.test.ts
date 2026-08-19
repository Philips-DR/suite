import { describe, expect, it } from 'vitest'
import { detectLanguage } from '../src/plan/languageDetect.js'

// Extracted verbatim from the real corpus (01-api-layer.md, 02-extraction-pipeline.md): most
// "unlabeled fences" in this project's target documents turn out to be ASCII flow diagrams using
// monospace alignment, not code in any language. Guessing a language for these would be worse than
// admitting none was detected.
describe('detectLanguage — real corpus diagram fences must stay undefined', () => {
  it('does not misidentify an arrow-based call-flow diagram', () => {
    const diagram = [
      'HTTP request',
      '  → FastAPI app (src/api/main.py)',
      '  → CORS / GZip / timing middleware',
      '  → v1 or v2 router',
    ].join('\n')
    expect(detectLanguage(diagram)).toBeUndefined()
  })

  it('does not misidentify a state-machine transition diagram', () => {
    const diagram =
      'INITIALIZE → EXTRACTION_RECOVERY → EXTRACTION_VERIFY → NORMALIZE → VALIDATE\n' +
      '  → ANALYZE_DISCREPANCIES → [conditional] → REQUIRE_USER_CONFIRMATION / GENERATE_REPORT → END'
    expect(detectLanguage(diagram)).toBeUndefined()
  })
})

describe('detectLanguage — positive signatures', () => {
  it('finds python from a def or import line', () => {
    expect(detectLanguage('def f(x):\n    return x + 1')).toBe('python')
    expect(detectLanguage('import os\nfrom pathlib import Path')).toBe('python')
  })

  it('finds yaml from bare key: value lines', () => {
    expect(detectLanguage('name: my-service\nport: 8080')).toBe('yaml')
  })

  it('finds json from braces plus quoted keys', () => {
    expect(detectLanguage('{\n  "name": "x",\n  "port": 8080\n}')).toBe('json')
  })

  it('finds sql from a select ... from statement', () => {
    expect(detectLanguage('SELECT id, name FROM users WHERE active = true')).toBe('sql')
  })

  it('finds dockerfile from a leading FROM/RUN instruction', () => {
    expect(detectLanguage('FROM python:3.11\nRUN pip install -r requirements.txt')).toBe('dockerfile')
  })

  it('finds bash from a shebang', () => {
    expect(detectLanguage('#!/bin/bash\nnpm install')).toBe('bash')
  })

  it('finds javascript from const/function plus arrow or semicolon', () => {
    expect(detectLanguage('const x = 5;\nfunction f(a) { return a + 1; }')).toBe('javascript')
  })
})

describe('detectLanguage — does not guess', () => {
  it('returns undefined for plain prose, even text containing a colon', () => {
    expect(detectLanguage('This describes: the shape of things, and how they work.')).toBeUndefined()
  })

  it('returns undefined for a bare arithmetic expression', () => {
    expect(detectLanguage('15% × (customs_value + duty_amount)')).toBeUndefined()
  })
})
