# suite — where it stands, and what comes next

`CLAUDE.md` holds the rules for working here. **This file holds the state**: what is built, what is
rough, what is waiting on a decision, and the next steps in order. Update it when any of those
change — a new session should be able to pick up from here without the conversation that got us
here. Each tool keeps its own `plan.md` or `CLAUDE.md` for its internals; this covers the whole.

As of **2026-10-10**. audiobook is in the suite: merged with its history (`98c60e3`), then its MCP door,
jobs, web panel, uploads and docs, built, tested, run for real and pushed.

## What this is

A personal assistant and the single-purpose tools it runs, replacing the old `personal-ai`
monolith. One folder, one install, one start command — but separate programs that never share a
process, a module or a credential (see `CLAUDE.md`).

| Part | Folder | What it does |
|---|---|---|
| Web app | `web/` | Chat and Buttons modes over one shared state (Meetings, Documents, Audiobooks, Mail, Memory, History, Settings). Port 8751. |
| Backend | `assistant/` | API on port 8750. Starts the tools as MCP children, runs chat turns on the model, gates every write behind an approval, audits every call. |
| meet-ai | `meet-ai/` | Record, transcribe locally (faster-whisper), notes and formal minutes where every point must resolve to a verbatim quote. |
| docu-ai | `docu-ai/` | Markdown → properly formatted Google Doc, zero markdown residue. Looks: `technical`, `resume`. |
| mail-ai | `mail-ai/` | Gmail: sync, read, search; draft, review and send (send needs two presses over the rendered mail). |
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
7. **Localhost only**, for now. Deployment is an open decision (below), not a default.
8. **audiobook has no interface of its own** (2026-10-10). Its standalone web app was removed and every
   feature rebuilt in the suite's web app. It has its own `.venv` (weight and PyTorch's CPU index, not
   a version conflict), and a voice is cloned only with a consent statement the user writes.

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

Test counts on 2026-10-10: assistant 145, meet-ai 113, mail-ai 75, docu-ai 285, audiobook 83, web typecheck.

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
- **A CV keeps all its content**, so the tailored one is 3 pages; shortening is a separate request,
  and the draft check will show what was cut.
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

- **Agent memory and a database.** Today `assistant/memory.json` is a flat file (see
  `assistant/CLAUDE.md`, Memory).
- **Storage for file uploads, and the rest.** Today `assistant/uploads/` is a local folder
  (`assistant/CLAUDE.md`, Uploads).
- **User authentication.** Today: one user, one machine, a per-launch token (locked decision 4).
  Deployment option (c) below touches on accounts.

## Waiting on the user

Decisions or input only the user can give. Don't guess these.

1. **Correct spellings** for the association meeting (places, officers, members, visitors — listed
   in the 2026-09-26 conversation; the minutes' footer flags them). Then: teach them with
   `assistant__remember` (kind `spelling`) and regenerate that meeting's notes and minutes once.
2. **Deployment**: (a) just the user, from anywhere, over a private network such as Tailscale —
   about a day; (b) just the user on the public internet — Google login, HTTPS, credentials on the
   server, browser recording — a few days; (c) a team or customers — accounts, per-user data, a
   job queue, and Google's verification for restricted Gmail scopes if used outside the
   ayadata.ai Workspace — a project. Recommended: (a).
3. **The old folders** `~/Documents/{assistant,meet-ai,mail-ai,docu-ai}` still exist (~1.2 GB, all
   content now in `suite/`), and so does `~/Documents/audiobook` (3.4 GB, mostly its old `.venv` and
   caches, which were copied here). Delete only when the user says so. Committing in them would push
   to the old repos — don't.
4. **`docu-ai/plan.md` has the user's own uncommitted edit.** Never stage it; commit it only if asked.
5. **Start at login** as a background service, or keep running `./start` by hand. Undecided.

## Next steps, in order

1. When spellings arrive: lexicon → regenerate notes + minutes for `20260812_102457` → rebuild both
   Docs → trash the superseded ones (ask first).
2. Once deployment is chosen, build that option. For (a): bind to the private network's address,
   extend the backend's `LOCAL_HOSTS`/`ASSISTANT_ORIGINS` and the web app's Host check to match,
   HTTPS via the network's own certificates. Keep the token model.
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
   network, and each tool's last call. An expired AWS login is the usual first failure; the user
   renews it with `aws sso login --profile ayadata-bedrock`.
4. Check "Waiting on the user" above before starting anything it lists.
