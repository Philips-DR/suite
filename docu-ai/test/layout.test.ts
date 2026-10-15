import type { docs_v1 } from 'googleapis'
import { describe, expect, it } from 'vitest'
import {
  layoutFindings,
  layoutParagraphs,
  measureLayout,
  SHORT_LAST_PAGE_LINES,
  tabCount,
  type LayoutParagraph,
} from '../src/verify/layout.js'

/** A résumé's shape: a role heading, its dates line, and bullets. */
const paragraphs: LayoutParagraph[] = [
  { text: 'Experience', role: 'heading', level: 2 },
  { text: 'Machine Learning Engineer — Ayadata GH', role: 'heading', level: 3 },
  { text: 'Nov 2023 – Present · Accra, Ghana', role: 'lead' },
  { text: 'Built a voice survey platform for farmers.', role: 'bullet' },
  { text: 'Skills', role: 'heading', level: 2 },
  { text: 'Python, SQL and technical skills', role: 'bullet' },
]

/** Pages as pdftotext gives them: lines of text, bullet glyphs and all. */
const page = (...lines: string[]): string => lines.join('\n') + '\n'
const filler = (n: number): string[] => Array.from({ length: n }, (_, i) => `A line of ordinary body text, number ${i + 1}.`)

describe('layoutFindings — a heading stranded at the foot of a page', () => {
  it('flags a role heading and its dates line that end a page, with the bullets on the next', () => {
    // The real failure, twice in one day: heading3 had keepWithNext, the dates line did not.
    const result = layoutFindings(
      [
        page(...filler(40), 'Machine Learning Engineer — Ayadata GH', 'Nov 2023 – Present · Accra, Ghana'),
        page('● Built a voice survey platform for farmers.', ...filler(30)),
      ],
      paragraphs,
    )
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Page 1 ends with "Machine Learning Engineer — Ayadata GH / Nov 2023')
    expect(result.warnings[0]).toContain('page 2')
  })

  it('flags a heading alone at the foot', () => {
    const result = layoutFindings(
      [page(...filler(40), 'Experience'), page('Machine Learning Engineer — Ayadata GH', ...filler(30))],
      paragraphs,
    )
    expect(result.warnings.join(' ')).toContain('Page 1 ends with "Experience"')
  })

  it('sees a heading that wrapped onto two lines', () => {
    const result = layoutFindings(
      [
        page(...filler(40), 'Machine Learning Engineer —', 'Ayadata GH', 'Nov 2023 – Present · Accra, Ghana'),
        page(...filler(30)),
      ],
      paragraphs,
    )
    expect(result.warnings.join(' ')).toContain('Page 1 ends with')
  })

  it('does not flag a heading that is followed by its content on the same page', () => {
    const result = layoutFindings(
      [
        page(
          'Machine Learning Engineer — Ayadata GH',
          'Nov 2023 – Present · Accra, Ghana',
          '● Built a voice survey platform for farmers.',
          ...filler(40),
        ),
        page(...filler(30)),
      ],
      paragraphs,
    )
    expect(result.warnings).toEqual([])
  })

  // The match is on whole lines, from a line boundary. A bullet that merely ends with the same word
  // as a heading is not that heading.
  it('does not mistake a bullet that ends in a heading’s word for the heading', () => {
    const result = layoutFindings(
      [page(...filler(40), '● Python, SQL and technical Skills'), page(...filler(30))],
      paragraphs,
    )
    expect(result.warnings).toEqual([])
  })

  it('ignores the last page: a heading ending the document strands nothing', () => {
    const result = layoutFindings([page(...filler(30)), page(...filler(20), 'Skills')], paragraphs)
    expect(result.warnings).toEqual([])
  })

  it('is not thrown by spacing, soft hyphens or ligatures in the extracted text', () => {
    const result = layoutFindings(
      [page(...filler(40), 'Ex\u00adperience'), page(...filler(30))],
      [{ text: 'Experience', role: 'heading', level: 2 }],
    )
    expect(result.warnings.join(' ')).toContain('Page 1 ends with "Experience"')
  })

  // An education entry is a heading and one line, then the next section. Ending a page there strands
  // nothing — the line IS the entry — and flagging it would send a revision loop after a non-problem
  // (it did, in the first live run).
  it('does not flag a heading and lead line that are the whole entry, followed by the next section', () => {
    const education: LayoutParagraph[] = [
      { text: 'Education', role: 'heading', level: 2 },
      { text: 'BSc. Information Technology — BlueCrest', role: 'heading', level: 3 },
      { text: 'Accra, Ghana · CGPA 3.63', role: 'lead' },
      { text: 'Certifications', role: 'heading', level: 2 },
      { text: 'Natural Language Processing Specialization', role: 'lead' },
    ]
    const result = layoutFindings(
      [
        page(...filler(40), 'BSc. Information Technology — BlueCrest', 'Accra, Ghana · CGPA 3.63'),
        page('Certifications', 'Natural Language Processing Specialization', ...filler(20)),
      ],
      education,
    )
    expect(result.warnings).toEqual([])
  })

  it('flags a section heading and its note that end a page, when a deeper heading follows on the next', () => {
    const projects: LayoutParagraph[] = [
      { text: 'Selected Projects', role: 'heading', level: 2 },
      { text: 'Repositories are private; I’m glad to grant access on request.', role: 'lead' },
      { text: 'Akan–English Speech Pipeline', role: 'heading', level: 3 },
      { text: 'Hugging Face Transformers, PyTorch', role: 'lead' },
      { text: 'Fine-tuned Whisper.', role: 'bullet' },
    ]
    const result = layoutFindings(
      [
        page(...filler(40), 'Selected Projects', 'Repositories are private; I’m glad to grant access on request.'),
        page('Akan–English Speech Pipeline', 'Hugging Face Transformers, PyTorch', '● Fine-tuned Whisper.'),
      ],
      projects,
    )
    expect(result.warnings.join(' ')).toContain('Page 1 ends with "Selected Projects / Repositories are private')
  })
})

describe('layoutFindings — length', () => {
  it('reports the page count and the last page’s lines', () => {
    const result = layoutFindings([page(...filler(50)), page(...filler(12))], [])
    expect(result).toMatchObject({ measured: true, pages: 2, lastPageLines: 12, warnings: [] })
  })

  it('warns when the document is longer than the target, and says how little spilled', () => {
    const result = layoutFindings([page(...filler(50)), page(...filler(50)), page(...filler(4))], [], { maxPages: 2 })
    expect(result.pages).toBe(3)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('3 pages; the target is 2')
    expect(result.warnings[0]).toContain('last page holds 4 lines')
  })

  it('does not warn about length when within the target', () => {
    const result = layoutFindings([page(...filler(50)), page(...filler(30))], [], { maxPages: 2 })
    expect(result.warnings).toEqual([])
  })

  it('warns about a stray last page even without a target', () => {
    const result = layoutFindings([page(...filler(50)), page(...filler(SHORT_LAST_PAGE_LINES))], [])
    expect(result.warnings[0]).toContain(`last page holds only ${SHORT_LAST_PAGE_LINES} lines`)
    expect(result.warnings[0]).toContain('fit on 1 page')
  })

  it('does not call a one-page document a spill', () => {
    expect(layoutFindings([page(...filler(3))], []).warnings).toEqual([])
  })
})

const paragraph = (
  text: string,
  style: string,
  bullet = false,
): docs_v1.Schema$StructuralElement => ({
  paragraph: {
    elements: [{ textRun: { content: `${text}\n` } }],
    paragraphStyle: { namedStyleType: style },
    ...(bullet ? { bullet: { listId: 'l' } } : {}),
  },
})

describe('layoutParagraphs and tabCount', () => {
  const doc: docs_v1.Schema$Document = {
    tabs: [
      {
        documentTab: {
          body: {
            content: [
              { sectionBreak: {} },
              paragraph('Ada Okonkwo', 'HEADING_1'),
              paragraph('Data Engineer', 'NORMAL_TEXT'),
              paragraph('Experience', 'HEADING_2'),
              paragraph('Senior Data Engineer — Example', 'HEADING_3'),
              paragraph('Mar 2021 – Present', 'NORMAL_TEXT'),
              paragraph('Rebuilt a pipeline.', 'NORMAL_TEXT', true),
              paragraph('', 'NORMAL_TEXT'),
              paragraph('Closing note.', 'NORMAL_TEXT'),
            ],
          },
        },
      },
    ],
  }

  it('tells a heading from a lead line from a bullet from body text, and drops empty paragraphs', () => {
    expect(layoutParagraphs(doc).map((p) => [p.text, p.role])).toEqual([
      ['Ada Okonkwo', 'heading'],
      ['Data Engineer', 'lead'],
      ['Experience', 'heading'],
      ['Senior Data Engineer — Example', 'heading'],
      ['Mar 2021 – Present', 'lead'],
      ['Rebuilt a pipeline.', 'bullet'],
      ['Closing note.', 'body'],
    ])
  })

  it('carries a heading’s rank, with TITLE above heading 1', () => {
    expect(layoutParagraphs(doc).filter((p) => p.role === 'heading').map((p) => p.level)).toEqual([1, 2, 3])
    const titled: docs_v1.Schema$Document = { body: { content: [paragraph('A title', 'TITLE')] } }
    expect(layoutParagraphs(titled)).toEqual([{ text: 'A title', role: 'heading', level: 0 }])
  })

  it('counts tabs, nested ones too', () => {
    expect(tabCount(doc)).toBe(1)
    expect(tabCount({ tabs: [{ childTabs: [{}] }, {}] })).toBe(3)
  })
})

describe('measureLayout', () => {
  // Docs' PDF export puts a title page in front of every tab (CLAUDE.md, M4), so a several-tab
  // document's pages are not what a reader scrolls through. Said, not guessed. No network is needed:
  // it answers from the readback it was handed, before any export.
  it('declines to measure a document of several tabs, and says why', async () => {
    const auth = { client: () => Promise.reject(new Error('must not be called')) }
    const result = await measureLayout(auth as never, 'doc', { doc: { tabs: [{}, {}] } })
    expect(result).toEqual({ measured: false, reason: expect.stringContaining('title page per tab') as unknown })
  })

  it('reports a failure to export as unmeasured, never as an exception', async () => {
    const auth = { client: () => Promise.reject(new Error('export denied')) }
    const result = await measureLayout(auth as never, 'doc', { doc: { tabs: [{}] } })
    expect(result.measured).toBe(false)
    expect(result).toMatchObject({ reason: expect.stringContaining('export denied') as unknown })
  })
})
