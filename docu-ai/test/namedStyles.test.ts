import { describe, expect, it } from 'vitest'
import { documentStyleRequest, namedStyleRequests } from '../src/emit/namedStyles.js'
import { technical } from '../src/theme/presets/technical.js'

const requests = namedStyleRequests(technical)

describe('namedStyleRequests', () => {
  it('covers every named style the theme defines', () => {
    expect(requests.map((r) => r.updateNamedStyle?.namedStyle?.namedStyleType)).toEqual([
      'TITLE',
      'SUBTITLE',
      'HEADING_1',
      'HEADING_2',
      'HEADING_3',
      'NORMAL_TEXT',
    ])
  })

  // CLAUDE.md: never `*`. A wildcard mask resets every unspecified property to its default.
  it('never uses a wildcard field mask', () => {
    for (const request of requests) {
      expect(request.updateNamedStyle?.fields).not.toContain('*')
    }
    expect(documentStyleRequest(technical).updateDocumentStyle?.fields).not.toContain('*')
  })

  it('always includes named_style_type in the mask, which the API requires', () => {
    for (const request of requests) {
      expect(request.updateNamedStyle?.fields?.split(',')).toContain('named_style_type')
    }
  })

  it('masks exactly the leaves it sets, and no others', () => {
    const title = requests[0]!.updateNamedStyle
    expect(title?.fields).toBe(
      'named_style_type,text_style.weighted_font_family,text_style.font_size,text_style.bold,' +
        'text_style.italic,text_style.foreground_color,paragraph_style.space_above,' +
        'paragraph_style.space_below,paragraph_style.line_spacing,paragraph_style.alignment,' +
        'paragraph_style.indent_end',
    )
  })

  // Inheritance is the main source of formatting bleed, so these are set rather than left unset.
  it('pins bold and italic explicitly instead of inheriting them', () => {
    const body = requests[5]!.updateNamedStyle?.namedStyle?.textStyle
    expect(body?.bold).toBe(false)
    expect(body?.italic).toBe(false)
  })

  it('scopes to a tab when asked, because named styles are per-tab', () => {
    const scoped = namedStyleRequests(technical, 'tab-abc')
    expect(scoped.every((r) => r.updateNamedStyle?.tabId === 'tab-abc')).toBe(true)
    expect(requests.every((r) => r.updateNamedStyle?.tabId === undefined)).toBe(true)
  })

  it('emits a stable request shape', () => {
    expect(requests).toMatchSnapshot()
  })
})
