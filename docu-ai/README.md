# docu-ai

Point this at a folder of Markdown files. It hands you back one real Google Doc — properly
formatted, one tab per chapter — with none of the markdown syntax left showing.

## The problem it solves

If you've ever pasted Markdown into Google Docs, or used one of the "import markdown" features
built into Drive, you've seen the result: literal `**` where something should be bold, stray
backticks around code, `|` characters where a table should be, and everything dumped into one long
tab with no chapters. It looks like a text file that was formatted by accident, not a document
someone actually made.

This tool does the conversion properly instead. Bold text becomes bold. A fenced code block becomes
an actual shaded, monospaced block, not a paragraph with backticks around it. A markdown table
becomes a real Google Docs table with borders and a header row. Each source file becomes its own
tab, and a cover page is generated up front with a clickable table of contents. The goal is that
someone opening the finished document has no way of telling it wasn't formatted by hand.

## Why this is harder than it sounds

The tricky part isn't reading Markdown — plenty of tools already do that well. The tricky part is
Google Docs itself.

A Google Doc isn't stored as a tree of paragraphs and sections the way you'd picture a document
being organized on disk. Under the hood it's one long, flat stream of text, with styling ("this
part is bold", "this part is a heading", "this part has grey shading") painted on top like a
highlighter marking up positions in that stream. There's no API call that means "insert a styled
paragraph here." You insert plain characters, and then, separately, you tell Google Docs which
character positions to paint with which style.

That has a real consequence: the moment you insert anything, every position after it shifts. Insert
a sentence at the top of the document and the "position 500" you were planning to style a moment ago
might now be position 540. Get this wrong and you style the wrong text, or crash outright.

So the tool works in a strict order specifically to keep track of positions honestly, rather than
trying to compute them by hand and hoping the math holds up on a 40-page document.

## How it works, step by step

1. **Read the Markdown.** Each file is parsed into a structural understanding of its content —
   headings, paragraphs, bold/italic text, code blocks, tables, lists — using a standard, battle
   tested Markdown parser. At this stage the tool knows nothing about Google Docs at all; it's purely
   "what does this file contain."

2. **Plan the document.** The parsed content is turned into a neutral description of the document:
   "this is a heading," "this is a code block in Python," "this is a table with these rows." This
   description doesn't yet know what font anything will use or what a heading will look like — it's
   deliberately kept generic, the same way a book manuscript doesn't specify a typeface. This is also
   the stage that works out chapter titles, one per file, for the tabs and the table of contents.

3. **Translate it into Google Docs instructions.** This is where the actual look is decided — fonts,
   colors, spacing, shading — all pulled from a single design "theme" so every part of the document
   is visually consistent. The tool builds up a big batch of instructions: first create the document
   and its tabs and set up the visual theme, then insert all the actual text and tables, then — this
   is the important part — **read the document back from Google** to find out exactly where
   everything landed, and only then send the styling instructions (bold here, shading there, borders
   around that) using the real positions Google just confirmed. Nothing is styled from a guessed
   position; it's always from a position Google itself just reported back.

4. **Check the result.** After building, the tool reads the finished document back one more time and
   scans it for anything that looks like leftover Markdown — a stray `**`, a backtick, a `|` that
   should have become a table border. If anything survives, that's treated as a bug, not a rare
   edge case to shrug off.

## What you get in the final document

- One Google Doc, with one tab per source Markdown file (i.e., one tab per chapter)
- A cover tab with the document title and a table of contents where every entry is a real, clickable
  link that jumps straight to that chapter's tab
- Any ordinary link inside a chapter's own text that points at another chapter's source file also
  becomes a real, working jump to that chapter — not just the cover's table of contents
- Real headings, using Google Docs' own heading styles (so they show up in Google's own outline view)
- Bold, italic, and strikethrough text, rendered as actual formatting, not symbols
- Fenced code blocks rendered in a monospaced font with a shaded background box
- Tables with borders, a shaded header row that repeats if the table spans multiple pages, and
  correct left/center/right alignment per column
- Blockquotes, shown as an indented block with a left border (nested quotes get a heavier border)
- Smart quotes and dashes, the same typographic cleanup a careful human editor would do by hand

## What it doesn't do yet

This is a deliberately staged project, and a few things are intentionally not built yet rather than
half-done:

- **Syntax highlighting** inside code blocks (colored keywords/strings) — code blocks are correctly
  formatted as code, just not color-coded yet.
- **Images** embedded in the Markdown aren't handled yet.
- **Smarter, AI-assisted planning** — today, chapter titles and code-block languages are worked out
  with straightforward, predictable rules. There's a deliberate seam in the design for a
  smarter/LLM-assisted version of that step later, without it needing to touch anything else in the
  pipeline.

## Using it

Full one-time setup (installing Node, creating a Google API credential) is in `SETUP.md`. Once
that's done, the everyday commands are:

    npm start -- preview <folder>          # see how a folder would be structured — no changes made, no quota used
    npm start -- build <folder> [title]    # do the real thing: build the Google Doc
    npm start -- lint <documentId>         # re-check an already-built document for leftover markdown

## How we know it's correct

Three layers of checking, each catching something the layer before it can't:

1. **Automated tests that need no Google account at all** — they check that a given Markdown input
   always produces the exact same set of instructions to Google, so a change to the code can't
   quietly break formatting without a test noticing.
2. **A real end-to-end test against the live Google Docs API**, building an actual document, reading
   it back, and confirming it's structured correctly — including that every table-of-contents link
   really does point at the right chapter.
3. **A human actually looking at it.** Some things — a font silently substituted because Google
   didn't recognize it, a code block accidentally split across a page break — don't show up in any
   automated check. The document gets exported to PDF and looked at, because a stored value in an API
   response is not proof of what a reader actually sees on the page.

For the full engineering details — the exact API mechanics, every gotcha discovered along the way,
and the rules that keep the codebase honest — see `CLAUDE.md`. For the milestone-by-milestone build
history, see `plan.md`.
