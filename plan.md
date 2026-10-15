# suite — where it stands, and what comes next

`CLAUDE.md` holds the rules for working here. **This file holds the state**: what is built, what is
rough, what is waiting on a decision, and the next steps in order. Update it when any of those
change — a new session should be able to pick up from here without the conversation that got us
here. Each tool keeps its own `plan.md` or `CLAUDE.md` for its internals; this covers the whole.

As of **2026-10-15**. The application-tailoring checks are built (`apply-ai`, docu-ai's layout and trash, the draft
marker), run for real through the chat on two real postings, and **not committed**. Deployment to the company
instance is pinned (below). audiobook joined on 2026-10-10 (`98c60e3`).

## What this is

A personal assistant and the single-purpose tools it runs, replacing the old `personal-ai`
monolith. One folder, one install, one start command — but separate programs that never share a
process, a module or a credential (see `CLAUDE.md`).

| Part | Folder | What it does |
|---|---|---|
| Web app | `web/` | Chat and Buttons modes over one shared state (Meetings, Documents, Audiobooks, Mail, Memory, History, Settings). Port 8751. |
| Backend | `assistant/` | API on port 8750. Starts the tools as MCP children, runs chat turns on the model, gates every write behind an approval, audits every call. |
| meet-ai | `meet-ai/` | Record, transcribe locally (faster-whisper), notes and formal minutes where every point must resolve to a verbatim quote. |
| docu-ai | `docu-ai/` | Markdown → properly formatted Google Doc, zero markdown residue. Looks: `technical`, `resume`, `letter`. |
| mail-ai | `mail-ai/` | Gmail: sync, read, search; draft, review and send (send needs two presses over the rendered mail). |
| apply-ai | `apply-ai/` | Checks for a job application, reads only: a posting's requirements against what the user's own material shows (gaps asked about once, before drafting), and a draft's claims traced to source lines. No model. |
| audiobook | `audiobook/` | PDF → audiobook in a cloned voice, locally (Docling to read, Pocket TTS to speak). Reading and rendering are background jobs. Own `.venv`. Its UI is the web app's Audiobooks panel. |

## Locked decisions

Settled; reopen only with new evidence, and say so here when one changes.

1. **Tools first.** Each tool is standalone with two front doors (CLI and MCP) over one
   `operations` layer; the assistant only classifies, calls, approves and audits. The design
   record is the "Tools-First Rebuild" plan doc (claude.ai artifact a2ae50bf-…); this file is newer.
2. **One repo, separate programs** (2026-09-27). Merged with histories rewritten under each folder.
   The old GitHub repos (Philips-DR/assistant, meet-ai, mail-ai, docu-ai, and audiobook — "keep old
   repo", 2026-10-10) stay live and are **not** to be archived — the user said so. `suite` pushes to github.com/Philips-DR/suite (private).
3. **Web app fully separate from the backend** (2026-09-28): own folder, server and port, calling the
   API across origins. No proxy, no page served by the backend.
4. **No token pasting.** `./start` makes a random token per launch and hands it to both programs;
   the web app's server injects it into the page at serve time. Google login was considered and is
   the wrong tool for one user on one machine — it becomes right only if the app is deployed.
5. **The model is Opus 4.6 on Bedrock**, SSO profile `ayadata-bedrock`. Opus 5 / 4.8 / Sonnet 5
   return 403 on this account (probed 2026-09-20). Minutes run at `medium` effort, notes at `high`
   — measured, see `meet-ai/CLAUDE.md`.
6. **Nothing a model writes is trusted on its word.** Notes and minutes drop any point whose quote is
   not in the transcript; a rewritten document is measured against its original at approval time.
7. **Localhost by default; reachable over Tailscale** (2026-10-10). The user chose a private network
   (Tailscale) over a public address: only devices signed in to the user's tailnet can reach it, and
   nothing is published to the internet. Done in containers (`./start-docker up --tailscale`); the host
   install stays localhost-only. A public address, with or without Cloudflare Access, was considered
   and not chosen. **Changed 2026-10-14, the user's call: Tailscale is dropped.** The suite is to run
   on a company EC2 instance the user may use but not otherwise administer (no DNS records, no
   security-group or IAM changes), reached for now through SSM. nginx on the host sits in front, with
   HTTP basic auth over HTTPS (a self-signed certificate, since there is no domain to get a real
   one) as the interim lock, and the Google sign-in (decision 9) to replace it. The page still hands
   its token to whatever can open it, so nothing is opened to the internet without that lock. The
   Tailscale sidecar stays in the repo, unused.
8. **audiobook has no interface of its own** (2026-10-10). Its standalone web app was removed and every
   feature rebuilt in the suite's web app. It has its own `.venv` (weight and PyTorch's CPU index, not
   a version conflict), and a voice is cloned only with a consent statement the user writes.
9. **A Google sign-in is the next big feature**, and the container setup is built to take it: one host
   name over HTTPS for both programs, exact hosts and origins from the environment, the page's token
   switchable off (`WEB_INJECT_TOKEN=0`), and one `authenticate()` in the backend where a session
   would plug in. What it changes is written down in `assistant/CLAUDE.md` ("Authentication").

## Built and verified

Each was tested (`./test`) and run for real; the real runs found most of the bugs.

| When | What | Where to read more |
|---|---|---|
| 09-20→25 | docu-ai credentials-in + MCP door; meet-ai layers, capture sessions, background transcription; mail-ai sync + compose/send gate | each tool's `CLAUDE.md` |
| 09-26 | Assistant as a long-running server; web interface (chat + buttons as one state); Meetings, Mail, Memory, History, Settings; job-finished notices | `assistant/CLAUDE.md` |
| 09-26 | First real meeting end to end: a 2-hour members' meeting (`meet-ai/transcripts/20260812_102457.*`) → transcript → notes → Google Doc | — |
| 09-26 | Formal minutes (43 points, 4 pages, 84 s) and `read_transcript`; notes titled by the meeting | `meet-ai/CLAUDE.md` |
| 09-27 | The suite: one repo, `./setup`, `./start`, `./test`, one shared `.venv` | `CLAUDE.md` |
| 09-28 | Frontend/backend split; automatic token hand-over; uploads (audio, `.md` files, folders) from Meetings, Documents and chat | `assistant/CLAUDE.md`, `web/README.md` |
| 09-28 | Drafting: the assistant can read an upload and write a tailored version (e.g. a CV for a role), measured against the original; CVs build in the résumé look | `assistant/CLAUDE.md` → Drafting |
| 10-10 | audiobook joined: merged with history, own `.venv`, MCP door (12 tools), detached background jobs that survive a backend restart and can be cancelled, PDF and recording uploads, path-confined audio playback and download, finished-job notices, and the Audiobooks panel (read a book, chapter table and exact text, corrections, voices with consent, render with progress, play and download). Run for real: Whisper heard a sample 100% right; a chapter rendered to MP3 + M4B; a render outlived `pkill` of the backend; the same flows through chat and in Chrome. | `audiobook/CLAUDE.md` → The suite integration; `assistant/CLAUDE.md` → Audio a tool made |

| 10-10 | **A new interface.** Overview dashboard (KPIs with deltas and sparklines, activity by tool per day, outcomes, time per tool, tool health, what is running, recent activity), Chat with suggestions and grouped tool chips, and every tool page rebuilt: Meetings as a Record → Transcribe → Write up flow, Audiobooks with chapters as a chart that is also the chooser, Mail as list-then-thread on a phone, History with filters and cross-filtering charts, Settings with a latency chart. A sidebar, rail or bottom tab bar by width; light, dark or system; Ctrl+K; animations that honour reduced motion; fonts bundled, no outside requests; pages loaded on demand (initial script 280 kB, down from 552 kB). Run for real: axe-core found and I fixed contrast, a nameless button and a missing heading, then 0 violations on all 9 pages × 2 themes × 2 sizes; 25 browser interaction checks; 28 unit tests; a real book driven through the Audiobooks page. | `web/DESIGN.md` |
| 10-10 | Containers: `./start-docker`, two images (backend 4.9 GB with every tool; web 0.4 GB), one `./data` volume, an optional Tailscale sidecar with HTTPS on 443 (web) and 8443 (API), exact hosts and origins from the environment, the API address found at run time. **Run for real:** both images build; every suite passes inside the image, and offline with an empty model cache; the stack comes up healthy and publishes only 127.0.0.1; all five tool servers start (same tool counts as the host); a real voice sample (Whisper: 100% match) and a render, cancelled and resumed, from the container; a container restart mid-render leaves it `interrupted` and a re-run resumes; the page opened by a different name in Chrome calls the API on that host at 8443, gets its event stream and plays audio, and a name nobody configured is refused; the microphone override lists PipeWire's sources. **Not run:** the Tailscale sidecar against a real tailnet (the image does accept every variable the compose file uses, but the serve config, MagicDNS and HTTPS certificates are unproven until it is joined), real TLS, an actual recording, and a server host. | `README.md` → In containers; `CLAUDE.md` → In containers |
| 10-15 | **Tailoring a CV, with checks.** Built from one real tailoring done by hand on two applications (World Bank, AfricaRice). **apply-ai** (new tool, 87 tests): `requirements` reads a posting into numbered items and sets each against the user's own files and confirmed facts — degree, language, named tools and years of experience checked exactly (years computed from the dated roles), the rest traced by shared words, character traits listed apart, the questions merged so none is asked twice; `claims` traces every figure, overstating word (daily, most, directly, led, deployed, open, fluent, extensive…), tool, language, degree and name in a draft to a source line, notices a limit the source put on a claim that the draft drops, and refuses an assistant-written draft as a source. **docu-ai**: `build` returns `layout` (page count; a heading stranded at a page foot; a page target missed; a stray last page) read from the PDF Docs exports; a `keepLeadWithNext` theme rule that fixes the stranded heading, shown on a control build; `layout`, `info` and a gated `trash` (approval shows the Doc's title, times and link); a full Drive now says so instead of "The caller does not have permission". **assistant**: drafts are marked `.draft`; `MAX_TOOL_ROUNDS` 12 → 30; no change to the prompt. **Run for real:** both real postings against the real CV reproduced every gap found by hand; the check found the one unconfirmed claim in the real finished CV (Linux); through the real chat on Bedrock, in an isolated copy, the model called `requirements` first, asked in one message, recorded the answers, fixed its own "daily", "most directly" and "fluent", built to a 2-page target (3 → 2 after a trim), trashed the superseded Doc through the gate, and on a second application reused what it knew and refused-then-corrected itself when it passed its own draft as a source. The backend image builds with poppler-utils and apply-ai and every suite passes inside it (`./start-docker test`; `pdftotext` and `./apply` checked in the image); **the running containers are still on the old image until `./start-docker up`** (not while a long render is going). **Not run:** a full-Drive 403 (unit-tested against the shape Google sent), the web app's pages for the new tool (it appears in Settings with the default colour). | `apply-ai/CLAUDE.md`; `docu-ai/CLAUDE.md` → Layout; `CLAUDE.md` → Tailoring a CV |

Test counts on 2026-10-15: assistant 150, meet-ai 113, mail-ai 75, apply-ai 87, docu-ai 328, audiobook 83, web 39 (+ typecheck).

## Known rough edges

Real, known, not yet fixed. Each is small unless marked.

- **Names in transcripts are misheard** ("Akra Tema", "Pretext", "Godwin Daydrew"). The fix exists —
  spelling facts in the assistant's memory become a lexicon applied before the model sees the
  transcript — but needs the correct spellings from the user (see below).
- **Numbered lists restart** in docu-ai when a quote or code block sits inside an item; each list
  segment gets its own `createParagraphBullets`. Unordered lists are unaffected.
- **Quotes in notes Docs sit at the left margin**, not under their bullet: Docs' PDF export ignores
  `indentStart` (docu-ai's CLAUDE.md). Would need a border-based inset per nesting level.
- **Speaker attribution is unreliable** on single-mic recordings; nothing is attributed by speaker
  label. Speaker enrollment is meet-ai's intended next step (its `plan.md`, M3b).
- **Transcription ETA is optimistic** (it slipped ~2× on the 2-hour meeting).
- **The terminal assistant (`assistant-cli`) has no upload or drafting tools** — those are
  registered only by the web server, which owns the uploads folder.
- **A CV keeps all its content unless a page target says otherwise.** `docu_ai__build` takes `maxPages` and
  reports the real page count; the model cuts the least relevant points to meet it and the draft check shows
  what was cut. The first trim in a real run also dropped three honest qualifiers; `apply_ai__claims` now
  notices a dropped limit, but misses a rewrite that merges several bullets into one.
- **Interface, small things.** Recording shows a clock and a state but no live audio level (the tool exposes none; peak dB appears after stopping). The charts have no zoom or export. Not tested on a real iPhone or an older Android browser: it was checked in Chrome at phone width with touch emulation, and `:has()` (the keyboard-aware chat on a phone) needs a 2023-or-newer browser, falling back to a tab bar that stays visible.
- **Audiobook, small things.** One job at a time (reading, rendering and cloning share the CPU). A
  file plays only once it has been fetched whole (the token travels in a header, so it is a blob, not
  a streamed URL): a four-hour M4B is ~115 MB before the first second. There is no button to delete
  finished audio or an uploaded book. A book is opened from an upload or by pasting its path — PDFs
  already in `~/Documents/books/` are not listed. Corrections are edited per book but not yet taught
  from chat. A render of a long book is hours (final-quest: ~4 h of audio), which is the machine,
  not the tool.

## To reason through later

Not decided, not scoped — noted here so it isn't lost. To be reasoned through together, since they
touch the same ground:

- **Teaching the system to tailor a CV to a posting: built 2026-10-15** (the user's go-ahead; it had been pinned
  until the applications closed). What was built, and why, is in `apply-ai/CLAUDE.md`, `docu-ai/CLAUDE.md` →
  "Layout" and `CLAUDE.md` → "Tailoring a CV". **Still open:**
  - The claims check is **advisory**. A model can skip it (the second run re-checked after fixing findings but
    not after a trim, so the tool's description now says to re-check after any edit), and it cannot tell that a
    sentence is true: a real draft passed with "dashboards" for one dashboard and "specializations" for one
    course. Making it unavoidable would mean the approval preview of `write_draft` calling it, which needs the
    assistant to name a tool or `write_draft` to move into apply-ai; neither was done.
  - **Existing drafts have no `.draft` marker** (the real `CV - …` and `Cover Letter - …` folders in
    `assistant/uploads/docs`), so a model can still pass them as the user's material. Mark them by hand, or ask.
  - A failed build still leaves a stray Doc (a letter with no `# heading` failed in docu-ai after creating it).
  - Letters: the model chose the `technical` look and needed four drafts to fit one page; the `resume` look
    then made them cramped (the user: "ugly, not well formatted"). docu-ai now has a `letter` look (10.5pt, 115%
    spacing, 10pt between blocks, inch side margins): a real letter that spilled onto a second page in the CV
    look sits on one page with room to spare. Built and looked at; **the running containers need
    `./start-docker up` before chat will offer it**. A letter has no date line or room for a signature: the
    markdown cannot express a gap, and the model does not know today's date.
  - The web app does not know the new tool: Settings lists it with the default colour and nothing links to it.
  - Only CVs and cover letters. Meeting minutes already have a quote rule; generalise when a second field
    needs the same piece.

- **Agent memory and a database.** Today `assistant/memory.json` is a flat file (see
  `assistant/CLAUDE.md`, Memory).
- **Storage for file uploads, and the rest.** Today `assistant/uploads/` is a local folder
  (`assistant/CLAUDE.md`, Uploads).
- **User authentication.** Now scoped, not open: a Google sign-in for one allowed account is the next
  feature (locked decision 9; `assistant/CLAUDE.md`, "Authentication"). Accounts for more than one
  person (per-user data, a job queue) remain the larger option (c) below.

## Waiting on the user

Decisions or input only the user can give. Don't guess these.

1. **Correct spellings** for the association meeting (places, officers, members, visitors — listed
   in the 2026-09-26 conversation; the minutes' footer flags them). Then: teach them with
   `assistant__remember` (kind `spelling`) and regenerate that meeting's notes and minutes once.
2. **Deployment: pinned 2026-10-14, the user's call — build none of it until they say so**
   (locked decision 7): a company EC2 instance
   (`i-0fa9e2caeda028982`, which the user may use), nginx with basic auth, then Google sign-in. Needed
   from the user: how the instance is reached (the ssh alias and the AWS profile for SSM; the login
   the assistant has, `ayadata-bedrock`, cannot see EC2 or SSM, and the user's admin profiles were not
   tried), its OS and size, and which inbound ports its security group already allows (the user
   cannot change it). A server has no microphone, so recording would move into the browser. `./renew-secrets`
   is built and tested against a stand-in for ssh, **not yet against the instance**.
3. **The old folders** `~/Documents/{assistant,meet-ai,mail-ai,docu-ai}` still exist (~1.2 GB, all
   content now in `suite/`), and so does `~/Documents/audiobook` (3.4 GB, mostly its old `.venv` and
   caches, which were copied here). Delete only when the user says so. Committing in them would push
   to the old repos — don't.
4. **`docu-ai/plan.md` has the user's own uncommitted edit.** Never stage it; commit it only if asked.
5. **Start at login** as a background service, or keep running `./start` by hand. Undecided.

## Next steps, in order

1. When spellings arrive: lexicon → regenerate notes + minutes for `20260812_102457` → rebuild both
   Docs → trash the superseded ones (ask first).
2. **Pinned (2026-10-14, the user's call; not started).** Deploy to the instance: nginx on the host (containers stay on 127.0.0.1) with the page on one port and
   the API on another, as the Tailscale setup did; proxy buffering off and no body limit for the event
   stream and uploads; no access log for `/api/events` (its `?token=` would be written to it); basic
   auth on the page's origin only, because a CORS preflight carries no credentials, so the API stays
   behind its token; a self-signed certificate. Then the Google sign-in (`assistant/CLAUDE.md`,
   "Authentication"), whose first step is to see whether Google accepts a redirect URI there. Through
   an SSM tunnel the page is on `localhost`, which Google does accept.
3. Give `assistant-cli` the document tools too, or say in its README that drafting is web-only.
4. docu-ai: continue numbering across a split list (reuse the list id), and indent notes' quotes
   by border inset — both are docu-ai changes, so confirm with the user first (they asked once
   that a minutes problem not be "fixed" in docu-ai when docu-ai wasn't the cause).
5. meet-ai: speaker enrollment (its `plan.md`, M3b).
6. audiobook: a way to delete finished audio and uploaded books; list `~/Documents/books/` as a library;
   let chat teach corrections from what the user says it misread (the tool already has the operation).

## Picking this up in a new session

1. Read `CLAUDE.md` here, then the `CLAUDE.md` of whatever tool you will touch.
2. `./test` — everything must pass with no credentials.
3. `./start`, open http://127.0.0.1:8751/, and look at **Buttons → Settings**: model login,
   network, and each tool's last call. An expired login is the usual first failure: `./auth --check`
   says which, and the user renews it with `./auth`.
4. Check "Waiting on the user" above before starting anything it lists.
