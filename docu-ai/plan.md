# docu-ai — build plan

Markdown → polished Google Doc. No markdown residue, real Docs formatting, chapters as tabs.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Stack | TypeScript | `remark`/`mdast` = richest GFM AST; `googleapis` ships types for every Docs `Request`, and this project is fundamentally "emit correct JSON" |
| Input | Folder of `.md` files | 1 file = 1 chapter = 1 tab; ordered by filename or optional `SUMMARY.md` manifest |
| Auth | OAuth desktop flow | Docs land in the user's own Drive. Scopes: `documents`, `drive.file`. Auth kept behind an interface so a service account drops in later |
| v1 scope | Deterministic core | Ship a real document first; highlighting + vision QA layer on after |

## Verified API facts (from the live discovery doc, not the guides)

- `addDocumentTab` / `deleteTab` / `updateDocumentTabProperties` **exist** — with `title`, `iconEmoji`, `index`, `parentTabId` (nested sub-tabs possible). The published tabs how-to guide is stale and implies otherwise.
- `updateNamedStyle` **exists** → redefine `TITLE`/`HEADING_1..6`/`NORMAL_TEXT` per tab. Set the theme once, then paragraphs inherit. Gives a real navigable outline.
- `ParagraphStyle` has `shading`, `borderLeft/Right/Top/Bottom`, `keepWithNext`, `keepLinesTogether`, `avoidWidowAndOrphan` → true code blocks and blockquotes with no table hacks.
- `pinTableHeaderRows` → header rows repeat across pages.
- `Link.headingId` / `Link.tabId` → clickable hand-built TOC, cross-tab links.
- **No** `insertTableOfContents` request → TOC is hand-built (we control formatting).
- **No** page-number auto-field → footers can carry static text only.
- `insertInlineImage` fetches its `uri` at insert time → local images must be uploaded somewhere publicly reachable first.

## Architecture

    md files → [1] parse  → mdast                    deterministic
             → [2] plan   → DocPlan IR (JSON)        deterministic in v1; LLM planner plugs in here
             → [3] emit   → batchUpdate Request[]    deterministic, typed, snapshot-tested
             → [4] verify → readback + lint          deterministic in v1; vision QA later

Layer 3 is a pure function `DocPlan → Request[]`: snapshot-testable with zero network calls. The `plan/` seam is
deliberate — the LLM planner (chapter segmentation, tab titles/emoji, captions, language detection) lands there
later without touching the compiler.

## Write sequencing (index arithmetic)

Docs addresses everything by UTF-16 offset; every insert shifts every later index.

1. Create doc → `addDocumentTab` per chapter → `updateNamedStyle` × N **per tab** (theme first, so inheritance is correct from the start) → `updateDocumentStyle` for margins/page setup.
2. Per tab: insert **all plain text** in document order with a running cursor (lengths exactly known), with `insertTable` placeholders where tables go.
3. `documents.get(includeTabsContent=true)` — read back real structure. Index source of truth *and* verification oracle.
4. Emit styling against real indices. Length-changing requests (table cell fills, bullets) apply in **descending index order**.

### Gotchas that will bite
- `createParagraphBullets` consumes the leading tabs used to express nesting → mutates text length. **Apply bullets last.**
- Paragraph style inherits from the *preceding* paragraph — a code block bleeds mono + shading into the next body paragraph. Reset explicitly at every block boundary; never rely on inheritance.
- Tables aren't linear. Never hand-compute cell indices — read them back (step 3), fill in reverse.

## Element mapping

| Markdown | Docs mechanics |
|---|---|
| Heading | `namedStyleType` + `keepWithNext` (no orphaned headings at page bottom) |
| Code block | paragraph `shading` + `borderLeft` accent + padding, mono font, `keepLinesTogether` |
| Inline code | mono + light `backgroundColor`, slight size reduction |
| Blockquote | `indentStart` + coloured `borderLeft` bar |
| `---` | empty paragraph with `borderBottom` |
| Table | `insertTable` → `pinTableHeaderRows`, shaded bold header, `updateTableColumnProperties` widths, per-column alignment from `:---:` |
| Hard break | `\v` (vertical tab) = in-paragraph line break, not a new paragraph *(confirm in M1)* |
| Typography | curly quotes, em/en dashes, ellipses; collapse md soft-wraps into flowing paragraphs |

## Test corpus

A real 10-file technical spec at `/home/philip/Documents/technical`; three files chosen for M1.
Selection, measurements, and the design decisions they force are in `test/fixtures/README.md` —
including two that change M2: narrow the page margins (95-char code lines will not fit the current
column), and treat inline code as the dominant construct rather than an afterthought (7,676 spans).

## Milestones

- **M0 — DONE (2026-08-19).** Built, PDF-verified, and looked at. *Was:* Split in two once it
  turned out a readback cannot detect a font fallback: `npm run m0` proves the write pipeline, and
  `npm run probe` proves the assumptions (fonts via PDF export, `addDocumentTab`, `\v`, mask dialect).
  Outcome: 24 fonts verified; `addDocumentTab`, `\v`, and both mask dialects confirmed live; the M0
  document renders in exactly Inter-Bold / SourceSerifPro-Regular / SourceSerifPro-It with no fallback.
  The theme moved to Inter + Source Serif Pro and 54pt margins on the strength of it.

- **M1 — DONE (2026-08-19).** Theme via `updateNamedStyle`; headings, paragraphs, inline marks
  (bold/italic/strikethrough/code/link), lists (including the mixed-nesting case below), rules;
  typography pass; page setup. Live-built against the real 01/02/03 fixture set (693 paragraphs, 68
  PDF pages), residue-linted clean, and reviewed page-by-page in the rendered PDF.

  Two real bugs only the live build surfaced, both fixed with regression tests: (1) a code span
  spanning two source lines keeps a raw `\n` in mdast's `inlineCode.value` — collapsed per
  CommonMark's own code-span rule, not by the typography pass. (2) a list mixing ordered top-level
  steps with unordered sub-bullets (real content in `01-api-layer.md`) was forced into one
  `createParagraphBullets` glyph family, turning the nested bullets into "a./b./c." lettering instead
  of discs — fixed by splitting into one call per contiguous ordered/unordered run.

  Known, deliberate gap: fenced code and tables still degrade to plain paragraphs (each code line is
  individually mono-styled but paragraph-spaced like prose, so a multi-line block reads as separate
  lines rather than one visual block) — exactly the M2/M3 boundary, confirmed by looking at the PDF.
- **M2 — DONE (2026-08-19).** Real fenced-code blocks: one \v-joined paragraph per block (not one
  paragraph per line), full-box shading/border, `keepLinesTogether`, at full page width per the
  M1-documented decision (prose narrows, code doesn't). Real blockquotes with a left border bar,
  nested-depth-aware. A deterministic language-detection heuristic in `plan/` (the seam plan.md
  already earmarked for the eventual LLM version), used only when a fence has no explicit tag.

  Scope call, not silently dropped: **syntax highlighting was descoped.** The real corpus's fences
  are mostly ASCII flow diagrams (arrows, alignment-dependent indentation), not code in any
  language — only one of the five untagged/tagged fences across 01/02/03 is actual source. Coloring
  tokens would touch a single fence, need a new tokenizer dependency, and isn't something a careful
  human formatting this by hand would typically do anyway. Revisit if a future corpus is
  code-dense rather than diagram-dense.

  Two things only the live build/render caught, beyond the design itself:
  - The old per-line degrade let a diagram block split across a page boundary mid-arrow (M1's own
    known gap). The single-paragraph + `keepLinesTogether` redesign fixes this as a side effect,
    confirmed by re-rendering the same diagram and seeing it hold together on one page.
  - **`ParagraphStyle.indentStart` is a no-op in Docs' PDF export** — verified across five separate
    documents (per-paragraph and named-style, 24–200pt, with and without a border), while
    `indentEnd` (already used to narrow the prose column) works fine. This broke the first
    nested-blockquote design (indent-per-depth); fixed by scaling border width/padding by depth
    instead, which *is* provably rendered. See CLAUDE.md's style-and-inheritance rules — this is
    the font-fallback lesson generalised past fonts: a stored value is not proof of a rendered one.
- **M3 — tables.** Readback strategy, pinned headers, column widths, alignment.
- **M4 — tabs.** Folder → chapters → tabs, manifest ordering, cover page, clickable hand-built TOC.
- **M5 — gates.** No-markdown-residue lint, golden request-JSON snapshots, CLI polish.

Deferred: syntax highlighting (Shiki → per-token `foregroundColor`), PDF-render vision QA loop, images, LLM planner.

## Acceptance gates

- **No-residue lint** (maps directly to "no markdowns in the doc"): read the built doc back; assert no literal `**`, backtick, `#`, or `|` survives in any text run.
- **Golden snapshots**: fixture `.md` → emitted `Request[]` JSON, no network.
- **Structural asserts**: every code paragraph is mono + shaded; every table has a pinned header; no trailing empty paragraphs.

## Layout

    src/
      cli.ts                  build | preview | lint | auth
      auth/google.ts          OAuth desktop flow + token cache (interface-backed)
      parse/                  loadDir.ts (discovery + SUMMARY.md), toAst.ts (remark + gfm)
      plan/                   types.ts (DocPlan IR), fromAst.ts, typography.ts
      theme/                  types.ts, presets/{technical,business,book}.ts
      emit/                   document.ts (4-phase orchestrator), namedStyles, text, code, table, lists, cursor
      verify/                 readback.ts, lint.ts
    test/fixtures/*.md + __snapshots__/
