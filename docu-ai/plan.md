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
- **M3 — DONE (2026-08-20).** Real tables: `insertTable` + readback-driven cell fills, pinned header
  rows (verified live across a real 3-page-spanning 15-row table — header repeats correctly on every
  page), a shaded bold header row, per-column alignment from `:---:`/`:---`/`---:` (unit-tested;
  the real corpus uses none, so unverified live — same honest caveat as M2's blockquote nesting).
  Column widths left at Docs' own default (EVENLY_DISTRIBUTED): the real corpus's tables are narrow
  (2–4 columns) and it looked fine live, so a width heuristic wasn't worth inventing speculatively.

  This is the milestone that forced the real four-phase sequence for the first time — a table's cell
  indices don't exist until the (empty) table has actually been inserted, so `compileDocument` split
  into `compileInserts` (theme + chained `endOfSegmentLocation` inserts, text and tables alike, no
  cursor arithmetic) and `compileStyleRequests` (given one readback, reconstructs every real index
  and builds the rest). A table cell's own inline styling (bold/code/links) can only be requested
  once its text exists, and that fill is itself length-changing — unlike every other block, a cell's
  `[fill, then style]` has to travel together as one unit through the same global descending-index
  sort as bullets, or an intervening fill elsewhere could invalidate one half without the other.

  Two real bugs the live build caught, both fixed with regression tests: (1) a fresh document body
  opens with an implicit `sectionBreak` before any content — invisible in a small hand-built probe,
  but it threw a lockstep paragraph-count reconstruction off by one at real-corpus scale. (2) a table
  cell's own `startIndex` isn't a valid insertion point (verified via a live 400 error) — the fix is
  `cell.content[0].startIndex`, one past the cell's own bound. Both are recorded in CLAUDE.md.

- **M4 — DONE (2026-08-20).** One tab per chapter (manifest ordering was already done, in M1's
  `loadDir.ts`). A cover tab: document title + a hand-built, genuinely clickable table of contents —
  each entry jumps to its own chapter's first heading via `Link.heading`, verified live end to end
  (created, read back, clicked-equivalent styling confirmed — Docs applies its own default link
  colour/underline automatically). `plan.title` used to default to chapter 1's own title, a fine
  stand-in when there was no cover to put it on; fixed to the source folder's name (or an explicit CLI
  arg), since a multi-chapter document needs its own title distinct from any single chapter's.

  This is the milestone that turned the "one readback" four-phase sequence into "two": a paragraph's
  `headingId` doesn't exist until it's actually been styled `HEADING_1` by *this same build*, so the
  cover's links can't be built until a readback taken *after* that styling has landed. Tab creation
  itself, by contrast, needed *zero* extra readbacks — `documents.create`'s response already includes
  the initial tab's id, and `batchUpdate`'s `replies[]` returns every new tab's id directly from the
  same call that creates it, so N chapters cost one batch, not N round trips.

  Genuinely new find from building at real-tab scale, not from any earlier probe: **PDF export
  auto-inserts a title page per tab**, showing the tab's title in Docs' own default style before that
  tab's real content. It's a PDF-export artifact — not part of the Docs UI reading experience — and
  it's now a permanent fixture of how a multi-tab build's PDF has to be read during verification (skip
  past it rather than mistake it for real content). Recorded in CLAUDE.md alongside the rest of the
  verified-facts list, the same way the M0-era tab and font gotchas were.

  Scope call, not silently dropped: **tab emoji were skipped.** `plan.md`'s own architecture section
  names "tab titles and emoji" as an LLM-planner task for a reason — a good emoji choice needs the
  same judgment a good chapter title does, and this project is still on the deterministic track by
  explicit earlier choice. Revisit alongside the planner, not before it.
- **M5 — DONE (2026-08-20).** Gates: the project-level checks CLAUDE.md and this file had been promising
  since M0 but never actually finished.

  **Tier-3 live integration test**, closing a gap that existed since the testing tiers were first
  documented: `test/live.build.test.ts` (`npm run test:live`), gated behind `DOCU_AI_LIVE_TESTS=1` so it
  never runs as part of `npm test` and never needs credentials to exist. Builds a real two-chapter tabbed
  doc, reads it back, and asserts tab titles, table cell contents, and — the part worth calling out — that
  the cover's TOC links actually resolve: each link's `heading.tabId`/`heading.id` is checked against the
  target chapter's own readback-derived `headingId`, not just "a link exists." Trashes the doc it creates
  on teardown via `afterAll`. Passed live end to end (~13s).

  **`preview` and `lint` CLI subcommands**, matching the CLI surface `plan.md`'s own layout section had
  documented since M0 but that never got built until now. `preview <dir>` runs parse+plan only — zero
  network calls, zero quota spent — and prints per-chapter block-kind counts, useful for sanity-checking a
  folder before spending a build. `lint <documentId>` re-runs the residue lint against a document that's
  already been built, without rebuilding it. Both share a `reportResidue()` helper with `build` so the
  three commands can't drift on what "clean" means.

  **ESLint**, the actual `npm run lint` gate. Configured with typescript-eslint's `recommendedTypeChecked`,
  not `strictTypeChecked` — strict flagged the codebase's own established idiom (a `!` non-null assertion
  once an index has already been bounds-checked, load-bearing throughout `emit/`'s index arithmetic) as if
  it were a bug; recommended keeps every type-aware rule that catches real mistakes (floating promises,
  unsafe `any` flow) without re-litigating a style choice already made on purpose. `no-explicit-any` is
  bumped to `error` explicitly, matching this file's own "no `any`" rule. One real tooling snag:
  `eslint.config.js` itself sits outside `tsconfig.json`'s `include` (deliberately — it's a tooling file,
  not project source), which broke typescript-eslint's `projectService`; fixed via
  `projectService: { allowDefaultProject: ['eslint.config.js'] }` rather than pulling a config file into
  the project's own compile.

  **`noUncheckedIndexedAccess` enabled** in `tsconfig.json` — it wasn't on, meaning `array[i]` typed as
  always-defined regardless of bounds, which is exactly the unsound default this project's own "index
  arithmetic is unforgiving" culture argues against. Turning it on surfaced two genuine gaps in production
  code, both regex capture-group accesses that are structurally guaranteed non-`undefined` by the pattern
  itself but that TypeScript can't see that far: `src/emit/units.ts`'s `rgb()` and
  `src/parse/loadDir.ts`'s SUMMARY.md link parser. Both fixed with a justified `!` plus a comment
  explaining *why* the group can't be missing, not a blanket suppression. A handful of test files needed
  the same treatment for array-destructured request assertions.

  End state, all three gates clean: `npx tsc --noEmit` clean, `npm test` 174/174 (1 correctly skipped —
  the live tier), `npm run lint` zero findings.

  Scope call, not silently dropped: this pass fixed real ESLint findings (an unused type import, two
  `Error` throws that dropped the original cause instead of chaining it, one genuinely dead assignment,
  several now-redundant type assertions once `noUncheckedIndexedAccess` was on) but did not do a second,
  independent pass looking for *new* categories of bug the way M0–M4 each did against the live API — M5 is
  about the gates existing and being honest, not about discovering new Docs API behaviour.

- **M6 — DONE (2026-08-20).** Cross-chapter link resolution: an ordinary markdown link naming a
  sibling chapter's own file (e.g. `[01-api-layer.md](01-api-layer.md)`, a real pattern found in the
  full-corpus build) now becomes a working jump to that chapter's tab, the same as the cover's TOC —
  instead of round-tripping as a dead `http://01-api-layer.md` link, which is what Google's own
  `Link.url` silently does with a bare relative string rather than rejecting it.

  `plan/fromAst.ts`'s `planDocument` resolves this: once every chapter's own source filename is known
  (only possible once all chapters are assembled, never inside `planChapter`'s single-file view), any
  link whose href matches one is rewritten into a new `chapterLink` Inline node carrying a plain index
  into `DocPlan.chapters` — still semantic, no Google concept involved yet.

  The real discovery was in `emit/`, not `plan/`: a table cell's own chapter link cannot resolve at
  the same *time* as a paragraph's, even though both need the same `Link.heading`. A paragraph's text
  already exists at the first readback, so its link range is stable and safe to resolve as late as the
  final phase. A table cell's text doesn't exist until the length-changing phase fills it, and
  `tableCellFills`'s own long-standing rule — a cell's fill and its styling can never be split into
  separate requests — turned out to bind the cell's link too. The first attempt deferred cell links to
  the same late phase as paragraphs and it silently failed live: the range captured during the fill
  had gone stale by the time the deferred request used it, invalidated by other cells/bullets filling
  in between. A unit test couldn't have caught this — the bug lived in the *timing* between two live
  API round trips — the live integration test (M5's own new gate) is what caught it. Fixed by moving
  the second readback earlier, to land between the non-length-changing style pass (which is what
  applies `HEADING_1`, making headingIds discoverable) and the length-changing one, so a cell's link
  now resolves immediately, inside its own atomic fill unit. See CLAUDE.md's "Cross-chapter link
  resolution" note and `emit/compile.ts`'s `compileChapterContentRequests` /
  `compileChapterLengthChangingRequests` split.

  `test/live.build.test.ts` was extended (not left to a new fixture) to cover both cases — a link in
  ordinary prose and a link inside a table cell — since a passing build over the small live fixture is
  exactly what this feature needs proven, live, before trusting it against the real corpus again.

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
