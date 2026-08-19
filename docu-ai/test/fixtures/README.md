# Fixtures

## Real corpus

`/home/philip/Documents/technical` — 10 markdown files, 436K, a real technical specification.
Referenced by path rather than copied in, so nothing proprietary lands in this repo. If these tests
need to run anywhere else, copy the folder in and update the path in one place.

### The three chosen for M1

`01-api-layer.md`, `02-extraction-pipeline.md`, `03-validation-engine-core.md` — chapters 1–3 in
sequence, right after the overview. Chosen over the earlier construct-sampled set (`00`, `06`, `07`)
because building three *consecutive real chapters* is a truer exercise of "one file = one chapter =
one tab" than three files picked to each maximise a different construct — M4's tab-per-chapter build
gets exercised as an actual mini-book, not three unrelated samples landing in three tabs.

| File | Lines | H2/H3 | Table rows | Fences | Nested list items | Inline code | Hrules |
|---|---|---|---|---|---|---|---|
| `01-api-layer.md` | 305 | 8/28 | 50 (2 cols) | 2, unlabeled | 5 | 1,045 | 0 |
| `02-extraction-pipeline.md` | 381 | 9/32 | 43 (3 cols) | 4, unlabeled | 0 | 996 | 8 |
| `03-validation-engine-core.md` | 1,142 | 10/25 | 34 (2 cols) | 4 (1 tagged `python`) | 5 | 1,426 | 10 |

Between them: 3,467 inline-code spans, 127 table rows, 10 fenced blocks, 10 nested list items, 18
rules. One H1 each, confirming the folder-wide pattern holds for this set too.

Two things this set covers less well than the construct-sampled set did, worth knowing rather than
hiding: nesting is shallower (10 items across two files vs. 13 in `07` alone, and `02` has none), and
fences are fewer (10 vs. 16). If the `createParagraphBullets` tab-eating case or code-block volume
need dedicated stress testing, `07` and `06` are still there to pull in as extra fixtures later — this
set isn't meant to retire them, just to be what M1 builds against first.

## What the corpus measured, and what it decides

- **Exactly one H1 per file, in all 10 files.** "One file = one chapter = one tab" is not a guess for
  this input, it is the literal structure. The folder-input decision holds.
- **No YAML frontmatter anywhere.** No frontmatter parsing needed for M1.
- **7,676 inline-code spans across the corpus** — an order of magnitude more than every other
  construct combined. Inline code is the dominant element in this document set, so its fidelity
  matters more than anything else, and it cannot be deferred. Each span is an `updateTextStyle`
  request: the 3 chosen files alone need ~3,467, or ~12 batches at 300 per batch. The batching design
  is load-bearing, not precautionary.
- **9 of the corpus's 10 fenced blocks in this set carry no language tag** — only one, in `03`, is
  marked `python`. A language-detection heuristic (or a graceful generic-monospace fallback when
  detection is unsure) is not a nice-to-have for M2; for this fixture set it is the common case, not
  the edge case.
- **Longest fenced code line: 95 characters** (in `03`). A 79pt-margin page gives only a ~454pt column
  — ~84 monospace characters at 9pt — so that line would wrap. This is why the technical preset moved
  to 54pt side margins (~504pt column, ~8.8pt fits 95 chars): **widen the column for code, don't shrink
  the font.**
- **But narrow margins help code and hurt prose — the two need different widths.** The 504pt column
  that fits code is a ~92-character measure at 11pt serif body text, well past the 65–75 characters
  prose reads comfortably at; the rendered M0 page confirmed this. The fix for M2 is not to pick one
  width: keep the wide column, and give *body* paragraphs an `indentEnd` of roughly 72pt to pull the
  measure back to ~78 characters, while code blocks use the full 504pt. Page margins serve the widest
  element; per-block indents serve the rest.
- **Tables are narrow: 4 columns at most, usually 2.** Column-width fitting is not a hard problem
  here, so M3 can start simple.
- **Zero images, zero footnotes, zero task lists, 3 blockquotes, 1 HTML tag.** The image-URI plumbing
  limitation is moot for this corpus and should stay deferred.
