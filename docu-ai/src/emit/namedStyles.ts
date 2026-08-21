import type { docs_v1 } from 'googleapis'
import type { BlockSpec, ParaSpec, TextSpec, Theme } from '../theme/types.js'
import { optionalColor, pt } from './units.js'

export type NamedStyleType =
  | 'TITLE'
  | 'SUBTITLE'
  | 'HEADING_1'
  | 'HEADING_2'
  | 'HEADING_3'
  | 'HEADING_4'
  | 'HEADING_5'
  | 'HEADING_6'
  | 'NORMAL_TEXT'

/**
 * Field masks are snake_case (matching the examples in the API reference) and always enumerate
 * exactly the leaves we set. Never `*`: on an update request that resets every unspecified property
 * to its default, which is a silent, document-wide wrecking ball.
 */
export function textStyleFor(spec: TextSpec): {
  style: docs_v1.Schema$TextStyle
  fields: string[]
} {
  const style: docs_v1.Schema$TextStyle = {
    weightedFontFamily: { fontFamily: spec.font, weight: spec.weight ?? 400 },
    fontSize: pt(spec.sizePt),
    // Set explicitly rather than left unset. An unset field inherits from the parent style, and
    // inherited bold/italic is exactly how formatting bleeds from one block into the next.
    bold: spec.bold ?? false,
    italic: spec.italic ?? false,
  }
  const fields = ['weighted_font_family', 'font_size', 'bold', 'italic']

  if (spec.color !== undefined) {
    style.foregroundColor = optionalColor(spec.color)
    fields.push('foreground_color')
  }
  if (spec.backgroundColor !== undefined) {
    style.backgroundColor = optionalColor(spec.backgroundColor)
    fields.push('background_color')
  }
  return { style, fields }
}

export function paragraphStyleFor(spec: ParaSpec): {
  style: docs_v1.Schema$ParagraphStyle
  fields: string[]
} {
  const style: docs_v1.Schema$ParagraphStyle = {}
  const fields: string[] = []

  if (spec.spaceAbovePt !== undefined) {
    style.spaceAbove = pt(spec.spaceAbovePt)
    fields.push('space_above')
  }
  if (spec.spaceBelowPt !== undefined) {
    style.spaceBelow = pt(spec.spaceBelowPt)
    fields.push('space_below')
  }
  if (spec.lineSpacingPct !== undefined) {
    style.lineSpacing = spec.lineSpacingPct
    fields.push('line_spacing')
  }
  if (spec.keepWithNext !== undefined) {
    style.keepWithNext = spec.keepWithNext
    fields.push('keep_with_next')
  }
  if (spec.alignment !== undefined) {
    style.alignment = spec.alignment
    fields.push('alignment')
  }
  if (spec.indentStartPt !== undefined) {
    style.indentStart = pt(spec.indentStartPt)
    fields.push('indent_start')
  }
  if (spec.indentEndPt !== undefined) {
    style.indentEnd = pt(spec.indentEndPt)
    fields.push('indent_end')
  }
  return { style, fields }
}

/**
 * The theme, expressed as redefinitions of the document's named styles. Applying these first means
 * every paragraph inserted afterwards only has to declare `namedStyleType` and inherits the right
 * font, size, colour, and spacing — and the document gets a real navigable outline for free.
 *
 * Named styles are per-tab: styling tab 1 does nothing for tab 2.
 */
export function namedStyleRequests(theme: Theme, tabId?: string): docs_v1.Schema$Request[] {
  const mapping: Array<[NamedStyleType, BlockSpec]> = [
    ['TITLE', theme.title],
    ['SUBTITLE', theme.subtitle],
    ['HEADING_1', theme.heading1],
    ['HEADING_2', theme.heading2],
    ['HEADING_3', theme.heading3],
    ['NORMAL_TEXT', theme.body],
  ]

  return mapping.map(([namedStyleType, block]) => {
    const text = textStyleFor(block.text)
    const para = paragraphStyleFor(block.para)
    const fields = [
      'named_style_type',
      ...text.fields.map((f) => `text_style.${f}`),
      ...para.fields.map((f) => `paragraph_style.${f}`),
    ]

    const request: docs_v1.Schema$UpdateNamedStyleRequest = {
      namedStyle: { namedStyleType, textStyle: text.style, paragraphStyle: para.style },
      fields: fields.join(','),
    }
    if (tabId !== undefined) request.tabId = tabId
    return { updateNamedStyle: request }
  })
}

export function documentStyleRequest(theme: Theme, tabId?: string): docs_v1.Schema$Request {
  const request: docs_v1.Schema$UpdateDocumentStyleRequest = {
    documentStyle: {
      pageSize: { width: pt(theme.page.widthPt), height: pt(theme.page.heightPt) },
      marginTop: pt(theme.page.marginTopPt),
      marginBottom: pt(theme.page.marginBottomPt),
      marginLeft: pt(theme.page.marginLeftPt),
      marginRight: pt(theme.page.marginRightPt),
    },
    fields: 'page_size,margin_top,margin_bottom,margin_left,margin_right',
  }
  if (tabId !== undefined) request.tabId = tabId
  return { updateDocumentStyle: request }
}
