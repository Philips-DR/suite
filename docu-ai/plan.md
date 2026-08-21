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

- **M7 — syntax highlighting — DONE (2026-08-20).** Per-token colour inside fenced code blocks. The
  scope below is grounded in measurements against the real corpus, not estimates — the numbers are
  reproducible from `/home/philip/Documents/technical`.

  **Step 1, before any implementation: probe that per-run `foregroundColor` actually renders.**
  Nothing in `src/` currently sets `foregroundColor` on a per-run `updateTextStyle` — only
  `theme/`+`namedStyles.ts` set it, at named-style level. Named-style colour demonstrably renders;
  that is **not** proof the per-run case does, and this project has been burned by exactly that
  inference once already (`indentStart`: echoed back perfectly by `documents.get`, total no-op in PDF
  export). PDF-verify it with `pdftotext`/rendered pages before writing anything else. **If per-run
  `foregroundColor` doesn't render, this milestone is dead** and no other decision here matters.

  **Tokenizer: `lowlight` (highlight.js), not Shiki** — a reversal of this file's own earlier
  parenthetical, on three grounds. (1) *Synchronous.* Shiki loads grammars asynchronously, which would
  force `planChapter` to become async and ripple through `cli.ts` and every test; lowlight is sync, so
  `plan/` stays sync and `emit/` stays pure. (2) *Semantic output, not baked colour.* Shiki resolves
  tokens against a Shiki theme and hands back hex colours — importing a palette that `theme/` doesn't
  own, straight through the layer boundary. highlight.js emits ~20 stable, documented, semantic class
  names (`hljs-keyword`, `hljs-string`, …) that map cleanly onto a colour table `theme/` does own.
  (3) *Structured output.* lowlight returns a hast tree, so no HTML-string parsing. Registered
  languages: `all` = 192 and includes `dockerfile`; `common` = 37 and does **not**. Prefer a curated
  registration drawn from `all` (the languages `detectLanguage` knows, plus the fence tags real
  corpora actually use) over registering all 192 — an unregistered language must fall back to today's
  unhighlighted block, never throw.

  **Layer placement.** Tokenize in `plan/`: a token *kind* (`keyword`, `string`, `comment`) is
  semantic, not visual, so it belongs in the IR under this file's own rules — and `plan/` already owns
  the sibling concern (`languageDetect.ts`), which the architecture section already earmarks for the
  planner seam. Colours live in `theme/` as `syntax: Record<SyntaxKind, Hex>`; `emit/` only ever looks
  them up. `CodeBlockNode` gains an optional `tokens?: CodeToken[]` and **keeps `code: string`
  unchanged**, so a block with no tokens emits byte-identically to today.

  **Never highlight an untagged fence.** Measured: the real corpus has 16 fenced blocks — 11 tagged
  (8 `yaml`, 1 `python`, 1 `dockerfile`, 1 `bash`) and 5 untagged. **All 5 untagged blocks are ASCII
  flow diagrams**, not code in any language (`HTTP client │ ▼ FastAPI (src/api) ──` and similar), which
  confirms `languageDetect.ts`'s own doc-comment observation at full-corpus scale. A highlighter turned
  loose on those would colour arbitrary words in an ASCII diagram — strictly worse than plain text. The
  existing guard is already correct and needs no addition: `detectLanguage` returns `undefined` for
  every one of the 5 (verified), so gating on "a known language" is sufficient. Its "must never guess"
  discipline is load-bearing for this feature, not just tidiness.

  **The real trap, and it fails silently.** `codeBlockStyleRequests` ends with a block-wide
  `updateTextStyle` whose field mask includes `foreground_color` whenever `theme.codeBlock.text.color`
  is set — and the `technical` preset sets it (`#202124`). In `compile.ts` that request is pushed
  *after* `renderTextBlocks`' per-run requests, so naive per-token colours are overwritten by the
  block-wide base colour. Every request succeeds, the readback reports the overwriting value as though
  it were intended, and only PDF export or human eyes reveal that nothing is highlighted. **Fix by
  removing `foreground_color` from the block-wide mask when a block is tokenized** and letting every
  run carry its own colour, rather than by reordering requests — no ordering dependency to get wrong
  later, and it matches this file's standing preference for explicit over positional.

  **Ride the existing machinery.** A syntax kind should become one more `FlatRun` field alongside
  `href`/`chapterLink` — precisely the pattern M6 just established — so `renderTextBlocks`' cursor
  arithmetic computes every range and `flattenInline`'s merge step collapses adjacent same-kind runs
  for free. This also sidesteps an offset trap worth naming: raw-source offsets do **not** map 1:1
  onto emitted text, because `codeBlockRuns` turns a blank line into a single space. Building runs from
  tokens means never computing that remap at all.

  **Request volume is a non-issue, contrary to the earlier worry.** Measured across all 11 highlightable
  blocks in the 188-page corpus: **175 coloured tokens**, in 9 distinct classes (`attr` 82, `string` 70,
  `number` 6, `bullet` 5, `literal` 4, `variable language_` 3, `comment` 3, `built_in` 1, `keyword` 1),
  and the hast tree is **flat — max nesting depth 1, zero nested spans**. With run-merging, expect a few
  hundred extra `updateTextStyle` requests document-wide, comfortably inside the existing 300-per-batch
  chunking. Note `variable language_` is a two-class `className`: the collapse rule must take the first
  `hljs-*` class, and an unrecognised class must degrade to the base colour rather than throw or guess.

  **Honest payoff assessment.** On *this* corpus the feature touches 11 blocks and 175 tokens across 188
  pages — a modest visual gain, dominated by yaml (keys one colour, values another). The case for
  building it is future code-heavy input (API docs, tutorials), where it is the difference between
  "formatted code" and "code that reads like code". Worth doing because it is small and contained, not
  because this corpus is crying out for it.

  **Non-goals for v1**, so they don't creep in: bold/italic per token kind (highlight.js class names
  carry no weight/slant information — that would be a `theme/` choice, and colour-only is the honest
  starting point); per-token background; highlighting inline `` `code` `` spans (a one-word span has no
  useful token structure); and language auto-detection *for highlighting purposes* beyond what
  `detectLanguage` already refuses to guess at.

  **Definition of done**, per CLAUDE.md: probe passes → fixture added (a tagged block *and* an untagged
  ASCII-diagram block, the latter asserting it stays unhighlighted) → IR asserted → request snapshot
  reviewed → live doc built → readback assertions pass → residue lint passes → opened in Docs and
  looked at with human eyes, which for this milestone is the only check that can confirm the colours
  actually landed.

  **Implementation.** Built exactly as scoped above, plus two things the scoping pass couldn't have
  found without writing the code:

  - `documents.get` appends a paragraph's trailing `\n` to its **last text run's own `content`
    string**, not a separate run — a code paragraph's final token (`1` in `return x + 1`) reads back
    as `"1\n"`. Caught by the live test's exact-equality check, not a unit test; fixed by trimming,
    the same way the existing table-cell assertions already did. Recorded in CLAUDE.md since it's a
    general readback fact, not specific to this feature.
  - The suspected block-wide/per-run `foreground_color` collision (flagged during scoping as "the real
    trap") was real and reproduced exactly as predicted in a dedicated live colour probe run *before*
    any implementation code was written: five words, five distinct per-run colours, rendered
    correctly on their own — then the same five words with a block-wide colour applied afterward,
    which flattened all five to one colour. Confirmed the fix (drop `foreground_color` from the
    block-wide mask when `highlighted`) before writing `codeBlockStyleRequests`'s real change, not
    after finding it broken.

  `CodeToken` (plan/types.ts) and `plan/syntaxHighlight.ts`'s `highlightCode()` do the tokenizing;
  `Inline` gained a `codeToken` variant (kind + text, no `code` mark — a fenced block's mono/shading
  already comes from the whole paragraph); `FlatRun` gained a `syntaxKind` field alongside M6's
  `chapterLink`, same pattern. `emit/blocks.ts`'s `codeBlockRuns` groups tokens back into per-line
  pieces via a small shared `tokenPieces` helper, splitting a token's own text on any embedded `\n`
  (a multi-line string/comment is one token spanning several code-block lines) and preserving the
  existing "blank line becomes a single space" rule so a tokenized block still can't lose a line to
  `flattenInline`'s zero-length-run drop. Untokenized blocks emit through the exact same function,
  byte-identical to before this milestone — verified by the pre-existing `compileBlocks` tests still
  passing unchanged.

  Verified: `tsc` clean, `npm test` (211/211, 1 correctly skipped), `npm run lint` clean, a dedicated
  live colour probe confirming per-run `foregroundColor` renders and the trap reproduces, and
  `npm run test:live` (extended to build a real Python fenced block and assert via readback that two
  different tokens carry two different `foregroundColor` values). Rebuilt the full 9-chapter real
  corpus and looked at the rendered PDF: a YAML checklist block reads with keys in orange and string
  values in green, exactly as designed, with no new residue-lint findings introduced.

- **M8 — images — DONE (2026-08-21).** Embedding `![alt](src)` as a real Google Docs inline image.

  **Unlike every milestone since M2, this one cannot be grounded in real-corpus measurement — the
  real corpus has zero images.** Worth naming explicitly rather than quietly scoping from guesswork:
  every number and decision below comes from the Docs API discovery document and a dedicated live
  probe (create a Drive file, try to reference it from `insertInlineImage` four different documented
  ways, isolate against a genuine external control), not from what real content needs.

  **The API's only insertion mechanism is a public `uri` — confirmed in the discovery doc, not
  assumed.** `InsertInlineImageRequest` takes `uri`, `location`/`endOfSegmentLocation`, and an
  optional `objectSize`. No bytes field, no base64, no Drive-file-id reference — Google fetches the
  `uri` once, at insert time. Hard constraints from the same doc: under 50MB, under 25 megapixels,
  PNG/JPEG/GIF only (**no WebP, no SVG**), and the `uri` string itself under 2kB.

  **Decisive live finding: a file uploaded to the user's own Drive cannot be used as that `uri`, even
  fully public — this is not a workaround gap, it's a dead end.** Tried, against the same probe
  document: the file's own `webContentLink`, `drive.google.com/uc?export=view`,
  `drive.google.com/uc?export=download`, and `lh3.googleusercontent.com/d/{id}` — all four rejected
  by `insertInlineImage` ("There was a problem retrieving the image" / "Access... forbidden" /
  "...not found"), both before AND after granting "anyone with the link" reader access, and again
  after an 8-second propagation delay. A genuinely external URL (a well-known public PNG, fetched on
  the exact same document, same request shape) **succeeded on the first try** — isolating the failure
  specifically to Drive-hosted URLs, not the mechanism itself, and ruling out propagation timing as
  the cause. No further Drive URL variant is worth trying without new evidence it'd behave
  differently — chasing an undocumented trick is exactly what CLAUDE.md's own culture warns against.

  **Consequence for markdown**: a `![alt](https://example.com/diagram.png)` — a remote URL — passes
  straight through to `uri` and embeds trivially. A `![alt](./diagram.png)` — a local file, no public
  host, the far more common real-world pattern — **has no viable v1 embedding path**. This is a real,
  load-bearing scope boundary, not a corner case to smooth over.

  **Sizing: Google's own default (when `objectSize` is omitted) is smarter than the discovery doc's
  wording suggests, but still wrong for this theme.** Live-verified: a 2048×1536 test image, inserted
  with no `objectSize`, came back sized at exactly 468×351pt — 468pt is precisely Docs' own built-in
  1-inch-margin content width (letter page 612pt − 72pt − 72pt), not a naive blow-up by pixel
  resolution. But this theme's actual prose column is narrower still: `marginLeftPt`/`marginRightPt`
  are 54pt (not 72), and every prose named style additionally carries `indentEndPt: 72` — a true
  usable width of 432pt, not 468. Relying on Docs' default would hang an image 36–72pt wider than the
  paragraph text around it. **v1 must compute and set `objectSize` itself**, scaled to the theme's own
  column width with aspect ratio preserved — which needs the image's natural pixel dimensions. No
  need for a full image-decoding dependency: PNG/JPEG/GIF all encode width/height in their first few
  dozen header bytes, cheap to fetch and parse directly.

  **Architecture: no new Block kind needed, unlike tables.** Verified directly against mdast's own
  output: `image` is a *phrasing* (inline) node, always nested inside a `paragraph` — and critically,
  "an image alone on its own line" and "an image mixed with other text" produce the **identical**
  AST shape (a paragraph whose `children` happen to include an image node; no structural marker
  distinguishes the two). So `Inline` gains one new variant (`{kind: 'image', src, alt, title}`),
  handled through the same `planInline`/`resolveInline` paths chapterLink and codeToken already
  established — no new Block, no new segment kind. A paragraph whose only child is an image is
  already exactly what most real markdown images look like; nothing extra is needed to make it read
  as its own visual block once emit/ inserts it.

  **An unembeddable image must not silently vanish** — this project's standing rule, going back to
  the very first message that started it. Recommendation: render the image's `alt` text as a plain
  paragraph in its place (so the reader sees *something* naming what should have been there, not a
  silent gap), and have the CLI print a build-time summary ("N image(s) could not be embedded: local
  file, no public URL" / "unsupported format: .svg"), the same spirit as the residue lint's own
  summary reporting. This needs a decision, not just an implementation — flagging it rather than
  deciding unilaterally.

  **A real correctness requirement, not a nicety: invalid images must be filtered out BEFORE the
  build, never sent and left to fail.** `batchUpdate` is atomic — CLAUDE.md's own rule. One
  `insertInlineImage` request for a local file or a `.svg`/`.webp` extension would fail against the
  live API and take the entire batch down with it, exactly the kind of failure this project has
  always caught by verifying assumptions first rather than discovering it live. Every image must be
  classified (embeddable / local-no-host / unsupported-format / uri-too-long) in `plan/`, before any
  request is ever built.

  **Worth including, not a stretch**: an image's `alt` (and `title`, if present) rendered as a small
  italic caption paragraph immediately below it. Docs has no native "caption" object tied to an
  image, so this is just reusing `renderTextBlocks` and the existing `italic` mark on an ordinary
  paragraph — zero new API surface, and alt text is frequently the most meaningful line near a
  diagram. Needs a decision on `alt` vs `title` precedence when both are present, not a new mechanism.

  **Non-goals for v1**: local-file embedding (no viable path found this pass — revisit only on new
  evidence, not another guess at a Drive URL trick); image resizing/cropping beyond fit-to-column;
  text wrap / floating images (Docs models this as a `PositionedObject` with anchoring — real
  complexity, a different feature from inline embedding); anything with animated GIF frames beyond
  Docs' own default handling.

  **Definition of done**, per CLAUDE.md: fixture added (a remote-URL image, a local-file image
  proving the deliberate fallback, an oversized/wrong-format image proving pre-filtering) → IR
  asserted → request snapshot reviewed → live doc built → readback assertions pass (image present,
  `objectSize` matches the computed column-width scaling) → residue lint passes → opened in Docs and
  looked at with human eyes, since a wrongly-scaled or misplaced image is exactly the kind of thing no
  automated check alone would catch.

  **Implementation.** Built as scoped, plus one thing the scoping pass's own reasoning couldn't have
  caught without live data: a "2x" filename is not proof of anything about an image's real pixel
  dimensions. The live test's own fixture (Google's own logo, filename `..._272x92dp.png`) turned out
  to be a genuine retina asset — its real PNG header reports 544×184, exactly double the filename's
  claim. Trusting the filename would have inserted it at native size, 112pt past this theme's 432pt
  column; reading the actual IHDR bytes (which the design already called for, on general principle)
  caught it automatically, capping to 432×146pt with no special-casing needed. Recorded as a real
  justification for the "always read real header bytes, never infer from a filename or URL" design
  choice, not a hypothetical one.

  Landed largely as designed: `Inline` gained an `image` variant and `Block` gained `ImageBlock` (for
  the sole-image-paragraph case — mdast's own shape makes the mixed-inline case free, handled by
  `planInline`'s pre-existing unknown-node fallback with zero new code); `emit/image.ts` holds
  classification, sizing, byte-level PNG/GIF/JPEG dimension parsing, and request-building, all pure;
  `emit/document.ts`'s new `resolveImages` does the one genuinely new I/O this milestone needed
  (fetching each distinct image src, Range-limited to 64KB, before `compileChapterInserts` ever runs);
  `Segment` gained `ImageSegment`, handled in `compileBlocks` exactly like `TableSegment` — flush,
  push, own insert path — except a non-embeddable image never reaches that far, degrading to its own
  alt text as an ordinary paragraph instead. `theme/types.ts`'s `PageSpec` gained explicit
  `widthPt`/`heightPt` (612×792, matching what this theme's own margin comments already assumed) and
  `documentStyleRequest` now sends `pageSize` explicitly — a real, if small, expansion beyond "just
  images": nothing needed an absolute page width before this milestone, and leaving it to whatever
  the account's own locale default happened to be was never actually safe.

  `image-size`, the obvious off-the-shelf dependency, was installed and then deliberately removed:
  `npm audit` surfaced two unfixed high-severity DoS advisories in its ICNS/JXL/HEIF parsers —
  formats this project will never touch, since Docs only embeds PNG/JPEG/GIF. Writing a ~90-line
  parser scoped to exactly those three formats, with a hard-capped marker-walk loop for JPEG, removed
  the vulnerable surface entirely rather than accepting it for functionality never used.

  Verified: `tsc` clean, `npm test` (250/250, 1 correctly skipped), `npm run lint` clean, a dedicated
  live probe proving Drive-hosted URLs are a dead end for `insertInlineImage` and that a flanking
  `'\n'` pair is what gives an inline image its own clean paragraph, and `npm run test:live` (extended
  with a real embeddable image and a real local-file image in the same chapter) confirming via
  readback that the embedded object's `sourceUri` and computed `size` are correct and that the local
  image's alt text appears as a visible paragraph with a matching CLI warning. Rebuilt a real document
  and looked at the PDF: the logo renders cleanly at the capped width, spaced correctly above and
  below, and the local-file fallback reads as ordinary, unmarked prose — indistinguishable from a
  human having written "A local diagram" as a caption-less placeholder.

Deferred: PDF-render vision QA loop, LLM planner.

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
