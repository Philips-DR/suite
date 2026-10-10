# The web app's design system

How the interface is built, so a new panel or chart looks like it belongs. Read this before changing
how anything looks. The look lives in `src/styles/`; the pieces are in `src/ui/` and `src/charts/`.

## Identity

A calm instrument panel. Cool slate neutrals with a hint of teal, **one brand accent** (teal), and a
validated chart palette used only for data and for *which tool* something belongs to. Boldness is kept
to the accent and the data; everything else is quiet. Type: **Bricolage Grotesque** for page titles and
section headings (`--font-display`), **Instrument Sans** for everything else (`--font-ui`, including
big numbers), **JetBrains Mono** for tool names, timestamps and code (`--font-mono`). All three are
bundled (`@fontsource-variable/*`): the app makes no request to any font service.

## Rules that are not negotiable

1. **Never write a literal colour, size or duration.** Use a token from `styles/tokens.css`
   (`var(--ink)`, `var(--brand)`, `var(--r-card)`, `var(--dur-2)`). Both themes (light, dark) are
   defined there, so a component that uses tokens is correct in both; one that uses `#fff` is not.
2. **Never name a theme in a component.** No `[data-theme]`, no `prefers-color-scheme` outside tokens.css.
3. **Colour follows the entity.** A tool has one colour everywhere (`charts/palette.ts`: `toolColor('meet-ai')`
   → `var(--s1)`). Status colours (`--ok-fill`, `--warn-fill`, `--bad-fill`) mean good/warning/bad and
   nothing else, and always come with an icon and a word. Never use a series colour for status or the reverse.
4. **Text never wears a series colour.** Marks carry colour; text uses `--ink`, `--ink-2`, `--ink-3`.
5. **Mobile first.** Every panel works at 390px wide with no horizontal scroll (tables become stacked rows,
   master/detail becomes list-then-detail), touch targets are at least 40px, inputs are 16px on a phone.
6. **Motion is tokenised and optional.** Use `--dur-*` and `--ease`, or the keyframes in `motion.css`.
   `prefers-reduced-motion` zeroes them all; never add a transition that carries information only through motion.
7. **Keep every behaviour.** A restyle changes how it looks and is operated, never what it does: the same
   tool calls, the same approvals, the same error messages, the same keyboard access.
8. **Nothing untrusted becomes markup.** Email bodies, transcripts, tool output: React text only, never
   `dangerouslySetInnerHTML`.
9. **Real data only in charts.** A chart plots what the tools returned. An empty period is an empty chart
   with a sentence saying so, never invented points.

## Layout and breakpoints (`styles/shell.css`)

`>=1024` sidebar; `640-1023` icon rail plus top bar; `<640` top bar plus bottom tab bar (four tabs and
"More"). The document scrolls. A page is `<PageHead/>` (rendered by `App.tsx`) followed by cards. Page
content max width is 1200px; the gutter is `--gutter` (16/24/32px). Use `.grid-2`, `.grid-3`, `.grid-split`
(wide + narrow) for card layouts; they collapse on their own. **Pick a column count the items fill**: an
odd card left alone on a row is a bug.

## Building blocks

| Need | Use |
|---|---|
| A surface | `<div className="card">`; `className="card lift"` when the whole card is clickable |
| Card heading with icon, title, sub, actions | `<CardHead icon={IconX} tool="meet-ai" title sub>actions</CardHead>` (`ui/CardHead`) |
| Nothing here yet | `<Empty icon title action>text</Empty>` (`ui/Empty`): say what will appear and how to add the first one |
| Rows in a card | `<ul className="list"><li>…</li></ul>`; `.list-main` for a row's title line |
| Chips, status | `.badge` (+ `.ok`, `.warn`, `.bad`), `.chip` (brand tint) |
| Segmented control | `<div className="seg" role="radiogroup"><button role="radio" aria-checked>` |
| Progress | `.bar` > `<div style={{width}}/>`, or `<Ring value label/>` (`charts/Ring`) |
| Big numbers | `.stat` tiles: see `pages/Overview.tsx` (`Stat`) |
| Drop files on a card | `<DropZone accepts onFiles label>` (`ui/DropZone`) plus `PickFiles` (`components/Upload`) |
| Icons | import from `ui/icons.ts` only (lucide). 16px in buttons, 17–20px in tiles. `aria-hidden` on decoration |
| Tables | `<div className="table-wrap stack-rows"><table>…`, with `data-label="Column"` on each `<td>`: on a phone each row becomes a stacked block |
| Forms | plain `input`, `select`, `textarea`, `button` are already styled; `.row` lays controls out, `.stack` stacks them |
| Page-level layout | `.panel` (vertical stack of cards, gap 16) |
| Muted / small / hint text | `.muted`, `.small`, `.hint` |
| Staggered entrance | add `className="stagger"` to a parent and `style={{'--i': index}}` to each child |

Buttons: default is quiet; `.primary` is the brand fill (one per view, the main thing to do);
`.danger` for destructive confirmations; `.ghost` for borderless; `.icon` for square icon-only (give it
an `aria-label`).

## Charts (`src/charts/`)

Plain SVG, no chart library, built to the dataviz skill's mark specs. Components:
`StackedColumns` (magnitude per day by tool), `HBars` (named things, thin bars, optional toggling),
`ShareBar` (parts of a whole, with icon + word legend), `Sparkline`, `Ring`, and `ChartCard`/`DataTable`
(a chart's frame with a Table view toggle, which every chart gets). Scales and formats are in
`scale.ts` (`niceMax`, `compact`, `duration`). Helpers for the audit log are in `pages/overviewData.ts`
(tested: `npm test`).

When adding a chart: choose the form by the data's job (stat tile for one number, bars for comparing
magnitude, stacked bars for parts of a whole, line only for time series); one series → one colour; thin
marks (bars ≤ 24px, 4px rounded at the data end, 2px surface gap between segments); hairline solid grid;
value labels on the bar tips or in a tooltip; a legend whenever there are two or more series; a table
view; a sentence for the empty case. No dual axes, no donuts for comparing close values, never a number
on every point. Categorical colour slots are fixed and validated (`charts/palette.ts`, `tokens.css`
`--s1..--s8`); a ninth category folds into "Other", never a new hue.

## Tool identity colours

meet-ai `--s1` blue · docu-ai `--s2` orange · mail-ai `--s3` aqua · assistant `--s4` yellow ·
audiobook `--s5` magenta. Use `toolColor(name)`; for a tinted tile use `style={{'--tile': toolColor(tool)}}`
on a `.navtile`.

## Theme

`ui/useTheme.ts` keeps light / dark / system in this browser only and sets `data-theme` on `<html>`;
`index.html` applies it before first paint so there is no flash.

## Verifying a change

`npx tsc --noEmit`, `npm test`, and look at it: with the dev server running
(`npm run dev`, see `web/README.md`), screenshot at 390×844 (phone), 820×1180 (tablet) and 1440×900
in both themes, and confirm `document.documentElement.scrollWidth <= window.innerWidth` at 390.
