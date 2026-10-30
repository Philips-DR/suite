# suite — where it stands, and what comes next

`CLAUDE.md` holds the rules for working here. **This file holds the state**: what is built, what is
rough, what is waiting on a decision, and the next steps in order. Update it when any of those
change — a new session should be able to pick up from here without the conversation that got us
here. Each tool keeps its own `plan.md` or `CLAUDE.md` for its internals; this covers the whole.

As of **2026-10-30**. **Deleting from the web app was built and run for real on 2026-10-30** (see "Built and verified"; committed and pushed). **The job-application workflow was run end to end through the model on 2026-10-30** (the African Languages Lab application; see "Built and verified"). The application-tailoring checks (`apply-ai`, docu-ai's layout and trash, the draft marker) were
built and run for real through the chat on two real postings on 2026-10-15, and are committed (`92d0f24`). A third
application on 2026-10-24 showed eight gaps; the plan to close them is under "Gaps found on 2026-10-24" below, and
**none of it is built yet**. On 2026-10-25 the database, caching and multi-user architecture was decided: Postgres
first, then Redis, then multi-user, then RAG — see "Database, caching and multi-user" below. **Layer 1 (Postgres) was
built and run for real on 2026-10-28; Redis, multi-user and RAG are not built. On 2026-10-29 Redis was deferred to
layer 3 (the user's call), after the queries it would cache were timed and cost 1 to 10 ms.** Containers are now the primary
runtime (locked decision 10), and `./start` now runs `./start-docker up`. The job-application workflow's first piece, **`web-ai` (reads a web page), was built on 2026-10-28**, and **mail-ai attachments on 2026-10-29** (tested and run on the real PDFs against a stand-in Gmail; a real Gmail draft with attachments was made and read back on 2026-10-30), and the end-to-end run through the model on 2026-10-30. Deployment to the company instance is pinned
(below). audiobook joined on 2026-10-10 (`98c60e3`).

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
   repo", 2026-10-10) stay live and are **not** to be archived — the user said so. `suite` pushes to github.com/Philips-DR/suite (**public since 2026-10-24**, the user's call; all 80 commits were scanned first and held no secret values).
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
10. **Containers are the primary runtime** (2026-10-25, the user's call). `./start` calls
    `./start-docker up`. The host-only path (starting the backend and web app as bare processes) is
    dropped. Postgres, Redis and any future infrastructure live as Compose services; no dual code path.
    Tests still run outside the container (`./test`) against file-based stores, with no Postgres needed.

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
| 10-28 | **Postgres (layer 1 of the database plan).** Memory, the audit log and sign-in sessions are in PostgreSQL when `DATABASE_URL` is set (compose sets it), and in the files they were otherwise, which is what every test uses. Each is an abstract store with a file and a Postgres version; every store method is async, which ran through `LocalTool.handler`, `prepare`, `tools_status` and `audit.record`. Numbered SQL migrations (`assistant/migrations/001_initial.sql`: all six tables; `users`, `dossiers`, `dossier_refs` laid down, unused), a runner in `db.py`, and a one-time import of `memory.json` and `audit.jsonl` that renames each to `.imported`. A `postgres:16-alpine` service in Compose, run as the host uid, no published port, data in `./data/postgres`. `./start` is now `./auth` then `./start-docker up`. Tools are not given `DATABASE_URL`. **Run for real:** the actual server on copies of the real `data/assistant` files, once on files and once on Postgres: 707 history rows and 15 facts identical through the API, last call per tool server identical, the lexicon identical, a write and read-back; then the real backend container (all five tool servers up, 52 tools; run on the existing image with the new code laid over it) on Postgres: it imported 15 facts and 707 audit rows and renamed the files, the data survived a backend restart with no second import, stopping Postgres left the API up (history and status empty, memory reads and writes failed honestly) and it recovered when Postgres came back, and no tool process held `DATABASE_URL`. **The live import on `./data` was run on 2026-10-29** (committed as `78fb441`): `./start-docker up` on a fresh `data/postgres`; the backend reported 15 facts and 707 audit rows imported and renamed both files `.imported`, byte-identical to a copy taken first (sha256). Compared against the old files: all 15 facts identical in Postgres; all 707 history rows identical through the running API, in order, except that a field with no value is left out instead of being `"error": null` (698 rows; the web app types `error` as optional-or-null and nothing tests for null). `lexicon.json` unchanged. **The web app was then driven in Chrome against it, the same day** (Overview, Memory, History and Settings at 390 and 1440 px wide; screenshots looked at): no console or page errors, no refused API call, no horizontal overflow; all 15 facts shown (the page's own counts: 1 person, 1 preference, 6 spellings, 7 other); the on-screen numbers equal ones recomputed from the old files (Overview 14 actions, 10 mail and 4 meetings, all succeeded; History 292 succeeded, 6 failed and 2 declined of the latest 300, so 98%; results by day 110, 2 and 1); Settings said everything was working once the logins were renewed. **Not run:** axe-core (not installed), the pages for Chat, Meetings, Documents, Audiobooks and Mail, and a real phone. | `assistant/CLAUDE.md` → The database |
| 10-28 | **The speaker models now come from Hugging Face, not GitHub** (`meet-ai/fetch-models.sh`, which the backend image build runs). An image build could not finish: the GitHub release download timed out twice (133 s each; from this host IPv4 to `github.com` timed out and IPv6 has no route, while Hugging Face answered). Both files are on Hugging Face (`csukuangfj/sherpa-onnx-pyannote-segmentation-3-0`, `csukuangfj/speaker-embedding-models`) with the same size and SHA-256 as the copies already in use, which the script now checks on every download (a wrong one is refused and leaves nothing behind). **Run for real:** from an empty folder on the host, and as a `RUN` step in BuildKit's network (12.7 s, where the old one failed), byte-identical to the models in use; a deliberately wrong hash exits 1 with no file left; then the real `docker/backend.Dockerfile` built to the end, and in that image the models, asyncpg 0.32.0 and the migration are present and the assistant tests pass offline (161 passed, 8 skipped). **Not changed, and still true:** the model step sits after `COPY . /app`, so any edited file re-runs it (about 12 s now, not a failure). | `meet-ai/fetch-models.sh` |
| 10-28 | **web-ai: a tool that reads the web (gap-plan step 3, job-application workflow 1a-1c).** `read_page` (the page's own text and its links, never a summary), `check_link` (HEAD only) and `github_visibility` (what a stranger sees, asked with no login; says it cannot tell a private repository from one that does not exist). Every address is resolved and every answer must be public, then the connection goes to that address (no second lookup); redirects are re-checked at every hop; no cookie, proxy, login or body; 5 MB counted after decompression, 30/60 s; a hidden element or an invisible character is dropped from the text. A refusal is an error result, so the audit log records it as failed. Registered in `tools.yaml`, `setup`, `test`, the Dockerfile and `start-docker test`. **Run for real:** 149 tests against a local server that records what it is sent (and four deliberate breaks of the code, each caught by its test); real refusals (169.254.169.254, localhost, `2130706433`, `file:`, a password in the address); example.com over TLS, an 89 KB Hugging Face page with 47 links, a PDF refused, GitHub's API for a public repository, a missing one and an account; launched over stdio through the assistant's own `execute()` (read-only, refusal audited `failed` with the reason, a good read `ok`); in a container on a compose-style network a service name resolving to a private address is refused while a plain TCP connection to it succeeds. **Found by running it:** the MCP SDK hides the reason of any error that is not its own `ToolError`; a source newline was being kept as a line break; a short whole page (example.com) was wrongly warned as script-built; "could not connect" hid that every address had timed out (IPv4 from this machine times out about half the time). **Not run:** a real job posting; a headless browser (not built); the whole backend image rebuilt with web-ai in it (done 2026-10-29: the image built and web-ai's 3 tools came up beside the other five servers, 49 tools in all, no errors in the backend log). **Not decided, and yours:** see "Waiting on the user", items 11 and 12. | `web-ai/CLAUDE.md` |
| 10-29 | **docu-ai: gap-plan step 1, approved by the user on 2026-10-29** (step 2, mail-ai, waits for a second yes). Word export asks Drive for an array buffer as PDF does, and every export is checked for what it is (`%PDF-` / `PK`), so garbage from Drive is an error, not a file; `export` takes its format from the name (`.docx`, `.pdf`, none = PDF); `resume` and `letter` write `out.pdf` and `out.docx` together and print the page count (the misplaced comment is fixed); `--title` on `build`, `resume`, `letter`; `--replaces <docId>` checks the old document before building and trashes it, through the existing `trash`, only if the new one is clean (no markdown left, no layout warning). **Not on the MCP door, on purpose:** through a model it would trash inside a build's approval, which shows an opaque id; the model keeps using `trash`, whose approval is previewed. **Run:** 369 tests (29 new), and five deliberate breaks of the code (no array buffer, no signature check, an unfinished build replacing, an already-trashed document accepted, the trash before the build), each caught by its test. Committed 2026-10-29 (`3219ce6`; web-ai is `b4fb2ba`, the speaker models `8ef074e`). **Not run against Drive** (the Google login had lapsed, `invalid_grant`, and was renewed later the same day; a live run builds a real Doc in the user's Drive, so it waits for a yes): a real Word export, a real `resume` with both files, and a real `--replaces` have not been seen, and `npm run lint` was already red on one committed line (`test/drive.test.ts:101`, an unbound method). | `docu-ai/CLAUDE.md` → Word, PDF and replacing |
| 10-29 | **mail-ai attachments (gap-plan step 2, approved 2026-10-29 after the user had seen the send-check tests).** `draft_new` takes `attachments` (`{filename, data, mime_type?}`, `data` standard base64); a message with files is multipart and each file arrives byte for byte. The send check covers every file by name and content, in order: change, add, remove, rename, replace or reorder one and the confirmation fails; a message with no files fingerprints exactly as before (two values pinned). `review` lists each file with its size above the body. Gmail keeps a file's bytes apart from the draft, so review and send each read them again; a file that cannot be read, or comes back short, stops both. Base64 is read strictly; an empty file, and a name with a slash, a control character or a right-to-left override, are refused before Gmail, and one bad file means no draft. `send` still takes only a draft id and a confirmation. **Run:** 132 mail-ai tests (57 new); thirteen deliberate breaks of the code, made in copies, each caught (the first run missed one, a weak test, which was fixed); the real CV and cover-letter PDFs (96,898 and 51,311 bytes) built into one 200,972-byte message and read back identical, reviewed, one flipped byte refused, the real bytes restored and sent against a stand-in Gmail. **Not run:** a real Gmail draft (the compose login is dead, and it writes to the real mailbox, so it needs the user's yes), so the attachment shape is Gmail's documented one, not an observed one; a model passing the base64 through chat (item 13 under "Waiting on the user"). The CLI's `draft` takes no files. | `mail-ai/CLAUDE.md` → Attachments |

| 10-30 | **Deleting, from the web app.** Clear chat (the conversation, not memory or the audit log; refused while a turn runs or an approval waits); delete an uploaded recording (Meetings), markdown batch (Documents) or PDF; move a Drive document to Drive's bin (Documents, through docu-ai's `trash` and its `info` preview); delete an audiobook (its audio, through a new destructive audiobook tool `delete_audiobook` whose approval shows a new read-only `describe_audiobook`, then its uploaded PDF). Every delete is asked about first in one dialog (what goes, what is not touched), audited, and reachable only by a button for uploads (no tool deletes a person's files). **Run for real:** a throwaway Google Doc built in the user's Drive and moved to the bin through the page (Drive itself then said `trashed: true`; Escape first left it untouched); throwaway recording, markdown batches, PDF and audiobook folder deleted through the page at 390 and 1440 wide, each checked gone on the server, the user's real uploads and audiobook folders the same, by name, before and after; Clear chat on a real conversation. **Found by running it, and fixed:** the dialog was trapped inside its animated card (its button pressed the row underneath; now drawn into `<body>`); Cancel was disabled while the audiobook dialog loaded, so focus stayed behind it; the audiobook dialog said the PDF was untouched while deleting it; a button chip outlived Clear chat. Tests: 30 new in the assistant, 24 in audiobook, and twelve deliberate breaks of the code, each caught (one first survived: a link to a file in the same uploads folder, which then got its test; audiobook had the same case tested from the start). **Not run:** a model's reply in the cleared chat (the AWS login had lapsed; the clear was tested on a failed turn), and a model calling `delete_audiobook` through chat's approval. **Left as they are:** recordings meet-ai made itself are not uploads and have no delete; voice-sample uploads can be deleted by the API but have no button; a PDF's `.corrections.txt` stays beside it. | `assistant/CLAUDE.md` → Deleting; `audiobook/CLAUDE.md`; `web/DESIGN.md` |

| 10-30 | **Files reach an email by path (job-application workflow step 3, and decision 13).** docu-ai `save_export` writes an exported Word or PDF file into the assistant's `uploads/exports` (`DOCU_AI_EXPORTS`) and returns its path, never its bytes; it is not read-only, and its approval shows the document's title (`info`). mail-ai `draft_new` takes `{path}`, read only from that folder (`MAIL_AI_ATTACH_ROOT`; links, outside paths, folders and oversized files refused), with 10 MB in all, base64 still taken for a small file. `export` (the web app's download) now tells a model never to use it to attach. **Run for real, without the model:** the real African Languages Lab CV and letter saved as Word files through the gate (654,050 and 651,163 bytes, `PK`), attached by path to one Gmail draft to the user's own address, read back by `review_draft` with the same confirmation (so Gmail holds the same bytes: the first real read-back of attachments), discarded through the gate, the user's draft to the recruiter untouched, the test files removed. Inside the container both tool processes were seen to hold the same folder. Tests: docu-ai 17 new, mail-ai 18 new; ten deliberate breaks, each caught. **Found:** a first version held invisible reversing characters in docu-ai's source; written as escapes now, and a scan of every changed file finds none. **Not run:** the model following these descriptions through a whole application (the AWS login had lapsed). **Not changed, noted:** `mail-ai/mailai/compose.py` (from 2026-10-29) keeps its list of reversing marks as the invisible characters themselves; it works, but reads as empty. | `docu-ai/CLAUDE.md` → save_export; `mail-ai/CLAUDE.md` → Attachments |

| 10-30 | **The job-application workflow, end to end through the model (workflow step 4).** The 2026-10-24 application run again in the real chat (Opus 4.6 on Bedrock, the running containers), opened with the user's own words from that day and `https://www.africanlanguageslab.com`; the email draft addressed to the user's own address, not the recruiter. The model read the homepage, Opportunities and Full-time roles and found the AI/ML Engineer link itself; that page builds itself in script, so `read_page` returned no text and a warning, and the model asked for the posting. Given the job site's public data address, it read job 37 (the 100-job list came back cut before job 37, so it fetched `/api/jobs/37` itself). Then: `requirements` first (it passed a marked draft as material, was refused, and retried without it); seven gaps asked in one message; GitHub checked with `github_visibility` and the false "Repositories are private" line removed; `claims` on both drafts, the letter's three dropped limits fixed and re-checked (a fourth left, with a stated reason that holds); the CV built at 3 pages against a 2-page target, the docu-ai project cut and said so, re-checked, rebuilt at 2; the 3-page Doc trashed through the gate; both saved as Word with `save_export`; one Gmail draft with both attached by path. Nothing sent; every approval read in full first. **Looked at:** both Docs as PDF (CV 2 pages, letter 1, no markdown left) and the Word files' text; Gmail's read-back gave the draft's own confirmation, so it holds the same bytes. Then everything the run made was removed (the draft discarded, three Docs in Drive's bin, three draft folders and both files deleted) and checked gone; the user's real draft to the recruiter and final Docs untouched; memory unchanged at 15 facts. **Found:** four things, under "Still open" → tailoring a CV. | — |

| 10-30 | **apply-ai: career claims, private code and the email body (the user's go-ahead, the same day).** `claims` takes `public_links`, the addresses web-ai found a stranger can open: a sentence calling code private is a `public link` finding when the address it names, or a repository on a code host, is public, and `unchecked` (saying how to check) when nothing was passed. "Spent my career" and its kin are watched phrases. The description says to check the email body before `draft_new`, and to check addresses before calling code private. `CV - ML Engineer` (the assistant's own, 2026-09-28) now carries the `.draft` marker. **Run:** 103 apply-ai tests (16 new) and thirteen deliberate breaks, each caught; seven real documents, old code against new, changed only where they should; the backend rebuilt (`./start-docker up`) and the chat driven for real: the model checked an email body unasked, fixed what it found and re-checked; asked to check a "repositories are private" line, it looked GitHub up, passed the addresses and told the user the line was false. **Not followed:** a line the user dictated went to `draft_new` without a re-check. Every draft was declined at the gate; nothing reached Gmail. | `apply-ai/CLAUDE.md` → Verified for real (2026-10-30) |

Test counts on 2026-10-30 (one `./test` run, all passed): assistant 191 + 8 Postgres tests that skip without `TEST_DATABASE_URL`, meet-ai 113, mail-ai 150, apply-ai 103, web-ai 149, audiobook 107, docu-ai 386 (+1 skipped, the live test), web 39 (+ typecheck).

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
  a streamed URL): a four-hour M4B is ~115 MB before the first second. A book is opened from an upload or by pasting its path — PDFs
  already in `~/Documents/books/` are not listed. Corrections are edited per book but not yet taught
  from chat. A render of a long book is hours (final-quest: ~4 h of audio), which is the machine,
  not the tool.

## Gaps found on 2026-10-24, and the plan to close them

A third real application, made with the checks built on 2026-10-15, showed what the system still cannot do.
**Nothing below is built.** Each gap was hit for real, and the code was read before the plan was written.

### What was hit

1. **Two copies of the state.** `./start` on the host keeps memory, uploads, audit log and mailbox beside the code;
   the containers keep them under `./data` (`compose.yaml` sets `ASSISTANT_MEMORY`, `ASSISTANT_UPLOADS` and the
   rest). On 2026-10-24 the host memory file held 9 facts and the container's 15, and the source CV differed
   between the two (the host copy has a later correction). The user was asked questions the other copy could
   already answer.
2. **No record of one application.** The posting, the confirmed facts, the drafts, the Google Doc ids and the
   email draft id lived in a scratch folder, `uploads/docs`, Drive, Gmail and a session's notes.
3. **No way to read a real posting.** It was on a script-driven site and was found only by reading that site's own
   API. A page fetch that summarises returned wrong labels for the site's figures. `apply-ai` takes pasted text only.
4. **The checks cannot see outside the user's files.** A CV line saying the repositories were private passed every
   check while most of them were public; `apply-ai` has no network, on purpose. It also flagged facts about the
   employer (a paper's name and year) as unsupported, because only the posting was given as context.
5. **docu-ai.** Word export fails: `exportDocumentWith` gets a `Blob` for `docx` and throws (`drive.ts`), and the
   CLI's `export` is PDF only. `resume` and `letter` do not print the page count (`build` does; a comment in
   `cli.ts` says `resume` does too, and is wrong). Every Doc is titled with its first heading. That is deliberate
   (`cmdOneDocument`: a résumé's heading is the name), but it leaves a CV and a letter with the same title in
   Drive. Each rebuild makes a new Doc, so superseded ones are trashed by hand.
6. **mail-ai.** A draft cannot carry attachments, and cannot be edited from the command line (`drafts.update`
   exists in the module; the CLI does not offer it). The mailbox was five days stale because nothing syncs it on a
   schedule.
7. **No pre-publish check.** Making `suite` public needed a hand-built scan of every commit. This file also mixed
   private operating notes with public documentation.
8. **The web app cannot open or download a built document** (also on the user's own to-do list). *Stale: the
   Documents page has opened Docs and downloaded them as PDF or Word since 2026-10-16 (`d5d5da2`).*

### The plan, in order

Sizes are rough. Steps 1 and 2 change docu-ai and mail-ai, so confirm with the user first.

0. **One state location (small).** `./start` exports the same paths under `./data` that `compose.yaml` uses. Merge
   memory by fact id. Show the user both copies of the source CV so they pick the current one. Delete nothing until
   they have.
1. **docu-ai (small).** Fix Word export (ask Drive for an array buffer, as the PDF export already does); let
   `export` choose the format from the file extension; make `resume` and `letter` print the layout report and fix
   the wrong comment; an optional title argument whose default stays the first heading; a `replaces <docId>`
   option that trashes the old Doc only after the new build succeeds, through the existing `trash`; write Word and
   PDF together. Tests need no credentials, as now.
2. **mail-ai (medium).** `./mail edit`. Attachments from the uploads folder only, under the same hostile-name rules
   as uploads. Attachment names and file hashes go inside the send fingerprint, so changing one invalidates a
   review the way `bcc` does. `send` still has no content parameter and the test that says so stays. Sync every
   30 minutes.
3. **A new `web-ai` tool, read-only (medium).** `read_page`: plain HTTP first, then a headless browser for
   script-driven sites; returns text with the URL, time and method, never a summary. `check_link`. And
   `github_visibility`, asked without a login so it answers what a stranger sees. GET only, no cookies or headers,
   private and local addresses refused, size and time limits, every call audited. Page text is untrusted data.
   Tests use a local fake server, no network.
4. **apply-ai (small to medium, stays network-free).** Accept link-check results and employer text as data, as it
   takes `facts` today. Flag a "private" or "confidential" claim next to a link that resolves publicly. Tune the two
   false alarms seen: a negated "not deployed to production", and a limit still present in reworded text.
   **Partly done 2026-10-30:** link results are taken (`public_links`) and a private claim is flagged. Not done:
   employer text as data (a real letter's "ACL 2026" paper was still flagged), and both false alarms (seen again
   the same day: "has not been deployed to production", the negator four words back; and a limit carried in the
   next sentence).
5. **Dossiers and fact provenance (large; do it with "Agent memory and a database" below).** A dossier is a
   generic record of one goal: a title, a status, ordered references (a Google Doc id, a Gmail draft id, a file, a
   URL) and facts scoped to it. No job logic in the assistant. Each fact gets a source (who said it, when) and a
   scope (global, or one dossier); an unconfirmed fact cannot be passed as `facts`. Memory stays the assistant's
   own state, which no tool may read.
6. **Web app (medium).** A Documents page that lists drafts with Word and PDF download (the file-serving rules
   already used for audio, with an extension allow-list); later a dossier view.
7. **Repo hygiene (small).** A `./publish-check` script: secret patterns across all history, plus the non-secret
   exposures (server ids, emails, names). Private operating notes move to a git-ignored file. The decision on the
   public history is item 10 under "Waiting on the user".

### Not building

Auto-send; a model inside the checks; a browsing agent; a workflow engine; a networked `apply-ai`.

### How we will know it works

Run the 2026-10-24 application again from nothing but the employer's address. The posting is found; only what
memory lacks is asked; a CV and letter come out as Word and PDF; a false "private" claim is flagged; an email draft
with both attached is made for the user to send; all of it sits in one dossier. Look at the output, as everywhere
else here.

## Job application workflow (2026-10-25)

**Built, and run end to end through the model on 2026-10-30** (see "Built and verified"). The goal: post a URL — a company website or a job listing — and the
assistant scans the site, understands the company, finds vacancies, tailors a CV, drafts a cover
letter, and sends the application email with attachments. Every destructive step has an approval gate.

This is the use case that ties gap-plan steps 2, 3 and 4 together. Dossiers (step 5) track
applications but are not blocking — the workflow works without them.

### The flow

1. The user posts a URL.
2. `web_ai__read_page` fetches it → raw text, no summary.
3. If it is a careers page (not a specific listing), the assistant reads the text, finds vacancy
   links, shows them. The user picks one. `read_page` again on that link.
4. `apply_ai__requirements` with the posting text from web-ai + the user's CV files.
5. The assistant asks gap questions (existing, unchanged).
6. The assistant drafts CV + cover letter (existing, unchanged).
7. `apply_ai__claims` verifies both drafts (existing, unchanged).
8. `docu_ai__build` + `layout` for each document (existing, unchanged).
9. `docu_ai__export` each as PDF → base64.
10. `mail_ai__draft_new` with the PDFs attached, the recipient from the posting, a subject line and a
    brief email body.
11. Review gate — the user sees the full email with attachments listed before anything sends.
12. `mail_ai__send_draft` — two-press gate, as today.

If the posting says "apply through our portal" (no email), the assistant prepares the documents but
stops before composing an email, and tells the user to upload manually.

### What is missing (three pieces)

**1. web-ai (gap-plan step 3). BUILT 2026-10-28** (`web-ai/`; see "Built and verified" and `web-ai/CLAUDE.md`). Where it differs from this text: `read_page` also returns `links` (the careers-page step needs them, and text alone loses them), `title`, `final_url`, `status`, `truncated`, `warnings` and `next`; there is **no headless-browser fallback** (a page that builds itself in script comes back nearly empty and says so); and a failed fetch is an error result, so the audit log records it as failed. A read-only MCP tool that fetches web pages and returns raw text.
No model, no summarisation, no cookies. `read_page(url)` → `{url, text, time, method,
content_type, size}`. Plain HTTP first; headless Playwright fallback for JS-heavy sites (optional —
if not installed, the tool says "paste the posting text instead"). `check_link(url)` (HEAD only) and
`github_visibility(url)` (unauthenticated GET). Safety: GET only, no cookies, private/local
addresses refused (resolve before connecting), 5 MB cap, 30/60 s timeout. Follows the apply-ai
pattern: own folder, `mcp` shell script, one entry in `tools.yaml`, shared `.venv`. Tests use a
local fake server, no network.

**2. mail-ai attachments (gap-plan step 2). BUILT 2026-10-29** (see "Built and verified" and `mail-ai/CLAUDE.md` → "Attachments"). Where it differs from this text: each file is fingerprinted by name and by content, with every field behind its own length; `review` lists every file above the body; a file whose bytes cannot be read stops the review and the send; and how the bytes reach `draft_new` is undecided (item 13 under "Waiting on the user"). As planned: `draft_new` gains `attachments: [{filename, data,
mime_type?}]` where `data` is base64. A CV + cover letter is ~300 KB — fine for MCP. `compose.py`
produces `multipart/mixed` MIME when attachments are present, single-part when not. The fingerprint
covers attachment filenames and content, so changing an attachment between review and send is caught.
`review_draft` shows attachment names and sizes in the preview. No new dependencies (Python `email`
stdlib). The alternative was file paths with a `MAIL_AI_ROOTS` env var, but the document size does
not justify the extra machinery.

**3. Orchestration descriptions.** The flow is encoded in tool descriptions and `next_step` response
fields — the existing pattern (apply-ai already does this). No change to the assistant's prompt.
`read_page` description: "pass the text to `requirements` as the posting." `export` description:
"pass the base64 to `draft_new` as attachments." `draft_new` description: "attach the exported
PDFs." apply-ai's descriptions already say "USE THIS FIRST" — no change.

### Edge cases

| Case | Handling |
|---|---|
| Portal-only (no email) | Detect from posting text, prepare docs, tell user to upload manually |
| JS-heavy careers page | Playwright fallback; if absent, ask user to paste text |
| Direct listing URL vs homepage | Assistant reads the text and adapts |
| PDF posting link | Detect content-type, refuse with "paste the text instead" |
| Specific subject line requested | The assistant reads the posting and follows it |
| Word format requested | `docu_ai__export` with `format: "docx"` |

### Build order

| Step | What | Depends on |
|---|---|---|
| 1a | web-ai: safety + HTTP fetch | — | **done 2026-10-28**
| 1b | web-ai: operations + MCP server + tests | 1a | **done 2026-10-28**
| 1c | web-ai: registration (tools.yaml, setup, test, Dockerfile) | 1b | **done 2026-10-28**
| 2a | mail-ai: Composition with attachments, multipart build_raw | — | **done 2026-10-29**
| 2b | mail-ai: draft_body reconstruction, fingerprint | 2a | **done 2026-10-29**
| 2c | mail-ai: MCP parameters + review rendering + tests | 2b | **done 2026-10-29**
| 3 | Orchestration descriptions (web-ai, docu-ai, mail-ai) | 1c + 2c | **done 2026-10-30** (with files by path: docu-ai `save_export`, mail-ai `{path}`)
| 4 | End-to-end test on a real application | 3 | **done 2026-10-30**, through the model (see "Built and verified")

Phases 1 and 2 are independent and can be built in parallel. Dossiers come later (needs Postgres).

### Not building

Auto-send; a browsing agent; a workflow engine; a networked apply-ai.

### How we will know it works

Run a real application from nothing but the employer's address. The posting is found; requirements
are extracted; gaps are asked; documents are built and exported as PDF; an email draft with both
attached is made for the user to send through the two-press gate. Look at the output.

---

## Database, caching and multi-user — the architecture plan (2026-10-25)

**Layer 1 is built (2026-10-28); layers 2 to 4 are decided, not built.** Each is its own piece of work;
nothing here is started until the previous one is done and tested. Where layer 1 differs from the text below: the
tests use the existing `asyncio.run` idiom, not `pytest-asyncio` (no new dependency); `DATABASE_URL` is built in
`compose.yaml` from `POSTGRES_PASSWORD` (documented in `.env.example`) rather than written out there; the one-time
import lives in `db.py` and runs when the pool connects; the Postgres tests run only with `TEST_DATABASE_URL`;
and tool processes are started without `DATABASE_URL`.

### Layer 1: PostgreSQL (first)

Replaces the three flat stores (`memory.json`, the in-memory `SessionStore`, `audit.jsonl`) with a
proper database. Also lays the schema for dossiers and multi-user, without building the logic yet.

**Stack:** raw `asyncpg` with numbered SQL migration files (`assistant/migrations/001_initial.sql`,
…). No ORM, no Alembic. A small runner in `assistant/assistant/db.py` creates a `migrations` table,
reads which files have been applied, and runs the rest at startup. The connection is a pool
(`asyncpg.create_pool`), created in the FastAPI lifespan and passed to each store.

**Schema (six tables):**

| Table | Replaces | Used now | Notes |
|---|---|---|---|
| `facts` | `memory.json` | yes | `id TEXT PK`, `user_id UUID FK nullable`, `kind`, `subject`, `content`, `source`, `scope_dossier_id UUID nullable`, `created_at DATE`, `updated_at TIMESTAMPTZ`. kind is CHECK-constrained to the existing set. |
| `sessions` | in-memory dict in `auth.py` | yes | `sid TEXT PK`, `email`, `expires_at TIMESTAMPTZ`. Survives a restart — the user no longer signs in again after a deploy. |
| `audit_log` | `audit.jsonl` | yes | `id BIGSERIAL PK`, `logged_at TIMESTAMPTZ`, `tool`, `arguments`, `outcome`, `error`, `duration_ms INT`, `result`, `origin`, `user_id UUID FK nullable`. Indexed on `logged_at` and `tool`. |
| `users` | nothing | schema only | `id UUID PK`, `email UNIQUE`, `name`. Multi-user adds rows and makes `user_id` required on `facts` / `audit_log`. |
| `dossiers` | nothing | schema only | `id UUID PK`, `user_id UUID FK`, `title`, `status DEFAULT 'active'`. The gap plan's step 5. |
| `dossier_refs` | nothing | schema only | `id UUID PK`, `dossier_id UUID FK`, `kind` (google_doc / gmail_draft / file / url), `value`, `label`, `position INT`. |

`user_id` is nullable on `facts` and `audit_log` for now; when multi-user lands it becomes required
and existing rows get assigned to the first user.

**Store abstractions.** Each store becomes an ABC with async methods and two implementations:

- `MemoryStore` → `FileMemoryStore` (the current file-based one, kept for tests) + `PgMemoryStore`.
- `SessionStore` → `MemorySessionStore` (the current in-memory one, kept for tests) + `PgSessionStore`.
  Pending OAuth state (10-minute-lived) stays in memory in both; only the 7-day session goes to Postgres.
- `AuditStore` → `FileAuditStore` (the current JSONL one, kept for tests) + `PgAuditStore`.

Which implementation runs is decided by whether `DATABASE_URL` is set: the container sets it, the
test runner does not.

**The async transition.** Moving to asyncpg makes the store methods async, which ripples through:

- `LocalTool.handler` becomes `async` (one-word change in `ToolRegistry.call`, which already awaits
  remote tools).
- `prepare()` becomes `async` (called in the async lifespan).
- `refresh_context` becomes `async` (called in `Hub.run`, which is async).
- `audit.record()` becomes `async` (called from `execute`, which is async).
- `builtins.py` handlers (`_remember`, `_forget`, `_recall`) become `async`.

Tests use `FileMemoryStore` / `FileAuditStore` / `MemorySessionStore`, which are `async def` wrappers
around sync file I/O. Tests add `pytest-asyncio` as a dev dependency.

**Data migration from files.** At first startup the backend checks for `data/assistant/memory.json`
and `data/assistant/audit.jsonl`. If they exist it imports their contents into Postgres and renames
them to `.imported`. Runs once, automatically, inside the migration runner.

**Infrastructure:**

- `compose.yaml`: a `postgres:16-alpine` service, a volume at `./data/postgres`, the backend
  `depends_on` it with `condition: service_healthy`.
- `assistant/requirements.txt`: add `asyncpg`.
- `.env.example`: add `DATABASE_URL=postgres://suite:suite@postgres:5432/suite`.
- `docker/backend.Dockerfile`: no system-level changes (asyncpg is pure Python).
- `./start`: becomes `./auth` then `exec ./start-docker up "$@"`. The host-only path is dropped
  (locked decision 10).

**What does not change:** tools (still MCP child processes), the web app, the API shape (no frontend
changes), the `./test` script, and the rule that no tool reads memory.

### Layer 2: Redis (deferred to layer 3 on 2026-10-29, the user's call)

**Not built, and not to be built before multi-user.** Measured on 2026-10-29 on a throwaway Postgres loaded with a
copy of the real audit log (707 rows), over loopback, median of 200 runs (50 for history): a session lookup 1.0 ms,
`/api/status` (`last_by_server()`) 3.7 ms, `/api/history?limit=2000` 9.8 ms plus 2.8 ms to encode a 272 KB body.
What that showed:

- The Overview polls status and history every 30 s (the History page every 15 s), not "every few seconds". Redis
  would save about 27 ms of query time a minute while the Overview is open, less its own round trip (not measured:
  no Redis was run).
- The totals and charts are worked out in the browser from raw rows (`web/src/pages/overviewData.ts`, used by `Overview.tsx`), so the server
  has no summary to cache. The cost that is real is the 272 KB sent each poll, which Redis does not change.
- Sessions are looked up only when Google sign-in is configured, which is not deployed; the launch-token path
  never reads the database.
- The two jobs that are real need later layers: rate limiting needs several users (layer 3), the embedding cache
  needs RAG (layer 4).
- **Watch:** `last_by_server()` reads the whole audit table on every call. Not timed on a larger table, and it may
  have a cheaper fix than Redis (an index, or a narrower query). Time it before reaching for a cache.

Revisit when layer 3 gives Redis a job. The text below is the plan as written on 2026-10-25, unchanged.

A cache layer. Solves repeated work across requests and things that are expensive to recompute but
fine to lose on restart.

**What goes in it:**

- **Session lookup.** The primary session lives in Postgres (survives restarts); Redis holds a fast
  copy so every `/api/*` request does not hit the database. Evict on logout, expire with the session.
- **Tool status.** The web app polls `/api/status` every few seconds. Cache the result for 10–30 s.
- **Audit summaries.** The Overview dashboard's KPIs, sparklines and activity-by-tool charts. Today
  every page load parses the whole JSONL (or, after layer 1, queries every row). Redis caches the
  aggregated result; invalidate on a new audit row.
- **Rate limiting.** Per-user rate limit on chat turns once there are multiple users, since each turn
  costs a model call.
- **Embedding cache (later).** When RAG arrives, cache the vector for a query string so repeated
  queries do not re-embed.

**What it does not cache:** model responses. Each turn depends on the full conversation; a stale
cached answer is worse than a slow one. Anthropic's own prompt caching on Bedrock handles the
expensive part.

**Infrastructure:** a `redis:7-alpine` service in `compose.yaml`, no persistence (`--save ""`), a
volume is not needed. The backend takes `REDIS_URL` and falls back to no caching if it is unset
(tests, development).

### Layer 3: multi-user (next, after Postgres; Redis comes with it, see layer 2)

With Postgres holding sessions and facts per user, and the Google sign-in already built
(`assistant/CLAUDE.md`, "Authentication"), the remaining work is:

- A `users` table row created on first Google sign-in for an allowed email.
- `user_id` becomes required on `facts`, `dossiers`, `audit_log`.
- Per-user uploads folders (`data/assistant/uploads/<user_id>/`).
- The model's context (`as_prompt_block`) is scoped to the signed-in user.
- `ASSISTANT_ALLOWED_EMAILS` grows from one address to a list.

### Layer 4: RAG (last, when the data outgrows the prompt)

Not until the fact count makes "send everything" too expensive or too noisy. The seam is already
there: `MemoryStore.relevant()` returns everything today, and its docstring says to narrow it only
when the prompt gets too big.

- A `pgvector` extension on the existing Postgres (no second database, no Pinecone, no Weaviate).
- An `embedding VECTOR(1024)` column on the `facts` table.
- A small, fast embedding model (Cohere `embed-english-v3.0` or Anthropic's own when available).
- `relevant(query)` goes from "return everything" to "embed the query, top-k by cosine similarity,
  always include spelling facts and active-dossier facts."
- `as_prompt_block` still produces the same shaped string; the model never knows the retrieval
  changed.

### Not building

- A separate vector database (Pinecone, Weaviate, Qdrant) — pgvector on the existing Postgres is
  enough at this scale and avoids a third service.
- An ORM (SQLAlchemy, Django ORM) — raw asyncpg with numbered SQL files is simpler and this is not
  Django.
- SQLite as a fallback for the host — there is no host path (locked decision 10).
- Caching model responses — each turn is contextual and a stale cache is worse than a slow one.

## Still open (not part of the database plan)

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
    **It happened on 2026-10-30:** `CV - ML Engineer` (the assistant's own, written 2026-09-28 per the audit log)
    was read and passed to `requirements` as the user's material until the user said otherwise. It was marked the
    same day. The host copies under `assistant/uploads/docs`, which nothing reads now, were not.
  - **The model asks to remember instructions as facts** (2026-10-30). Told "leave out published research" and
    "leave it out unless my CV shows it", it asked to remember "no published research" and "no … experience beyond
    what CV shows" as facts about the user, and three spellings of the referrer's name nobody gave. Both declined
    at the gate; only the person approving stops it.
  - **What the claims check did not see** (2026-10-30): a sweeping sentence with no figure, tool or watched word
    passed ("AI for Africans, by Africans — is work I have spent my career doing"), and the email body was never
    checked. **Both addressed the same day** (see "Built and verified"): "spent my career" is watched, and the model
    checked an email body unasked. Still true: a sweeping claim worded any other way passes, since the list is
    literal.
  - **A line the user dictates is not re-checked** (2026-10-30). Asked to add "my repositories are private ... as
    my CV says", the model went straight to `draft_new`; the check would have caught it (shown when asked). The
    check stays advisory: only the person approving stops this.
  - **A spelling fact rewrote the employer's name** (2026-10-30): memory's `AyaData` spelling turned the CV's
    "Ayadata GH" into "AyaData GH". The CVs already sent say "Ayadata".
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
- **Storage for file uploads, and the rest.** Today `assistant/uploads/` is a local folder
  (`assistant/CLAUDE.md`, Uploads). Moves to per-user folders under layer 3 (multi-user).
- **User authentication.** The Google sign-in is built but not deployed (locked decision 9;
  `assistant/CLAUDE.md`, "Authentication"). Multi-user is layer 3 above.

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
6. ~~**Host or container: which is used day to day?**~~ Decided 2026-10-25: containers (locked decision 10).
7. ~~**Step 5 of the gap plan:** generic dossiers with a database, or something lighter first?~~ Decided
   2026-10-25: Postgres, with the full dossier schema ready from the start. See "Database, caching and
   multi-user" above.
8. ~~**Step 3:** may the suite have a tool that fetches arbitrary web pages, with the limits listed there?~~ Decided
   2026-10-25: yes. The job application workflow is the driving use case — see "Job application workflow" above.
9. ~~**Steps 1 and 2** touch docu-ai and mail-ai: is one yes enough, or does each need approving?~~ **Decided 2026-10-29, the user's call: each separately.** Step 1 (docu-ai) is approved. **Step 2 (mail-ai) approved 2026-10-29**, after the user had seen the tests for the send check (attachments inside what a review covers), and built (see "Built and verified").
10. ~~**The public history of `suite`.**~~ **Decided 2026-10-30, the user's call: leave it.** Checked that day: the
    commit emails (philip@ayadata.ai on 97 commits, the personal Gmail on 1), the instance id in this file, the
    three applications' names and CV details in apply-ai's tests are in it; the phone number, the recruiter's and
    referrer's names and any secret are not. Original question: A few non-secret details are in it (a server id, a person's name, the names
    of earlier applications, commit emails). Removing them from history means rewriting `main` and a force-push,
    and copies may already exist. Remove, or leave?
11. ~~**Should a fetch be held for approval?**~~ **Decided 2026-10-29, the user's call: no, leave web-ai's tools ungated.** The risk stays as written in `web-ai/CLAUDE.md` ("What this does not stop"). Original question: `web-ai`'s tools are read-only, so the assistant's gate never stops one. A GET can carry data out in its address (a page the model read could tell it to fetch `https://evil.example/?q=<what it has seen>`); the 2048-character limit bounds one call, it does not stop it. Marking the tools as writes would make the assistant ask before every fetch. Reasoned, not demonstrated. Gate them, or leave them as the plan says?
12. **A headless-browser fallback for script-built pages?** Open; recommendation given 2026-10-29: not yet. A browser runs a page's scripts, which make requests the address checks do not cover, so it would need every request checked or its own isolated container, which is a project, not an extra; the 2026-10-24 posting was script-driven but was read through the site's own JSON API, which `read_page` can already return. Build it, as its own container, if a second real posting needs it. Not built: it would add a browser to the backend image and a surface that runs a page's scripts. Today such a page comes back nearly empty with a warning and the user pastes the text. Build it when a real posting needs it, or now?

13. ~~**How do a file's bytes reach `draft_new`?**~~ **Decided 2026-10-30, the user's call: by path** (built; see "Built and verified"). Option (a) could not work, by arithmetic: one model reply holds 16,000 tokens (`MAX_TOKENS`), and the smallest real file, a cover-letter PDF, is at least 17,000 as base64; each Word file at least 217,000. The 10 MB total cap was taken with it. The original question: Open (asked 2026-10-29). Today `docu_ai__export` returns the whole file as base64 text and a model would copy it into `draft_new`. Measured on the real files: the CV PDF is 96,898 bytes and the cover-letter PDF 51,311 (about 200,000 characters of base64 for the pair), and each Word file is about 650,000 bytes, not the ~300 KB assumed in the job-application section. Whether a model can copy that without changing a character has **not** been tested. (a) Keep base64 and try it on the real CV and letter through the chat: if the attached file matches `export`'s byte for byte, it stands. (b) Name a file in one allowed folder and let mail-ai read it: nothing in the assistant saves an exported file there today (the PDFs in `assistant/uploads/docs` were written by hand with docu-ai's command line), so docu-ai's `export` would have to, which is a docu-ai change needing its own yes. Recommendation: (a) first, (b) if the bytes come back wrong. (a) needs a draft made in the real Gmail, which writes to the real mailbox, so it needs the user's yes, and a live `mail-compose` login. Also undecided: a size cap on attachments (suggested: 10 MB in total).

## Next steps, in order

1. ~~**Postgres (layer 1 of the database plan).**~~ Built 2026-10-28, committed (`78fb441`) and the real import run 2026-10-29 (see "Built and verified").
   **The older host copies are deleted** (2026-10-30, the user's call): `assistant/memory.json` after all 9 of its
   facts were found identical in the database, and `assistant/audit.jsonl`, knowing 13 of its 628 rows
   (2026-10-19: an audiobook analysis and render, the rest mail syncs) were in no other place. (The two logins found dead
   on 2026-10-29, AWS and mail-compose, were renewed by the user the same day; `./auth --check` says all good.)
   The database password is the default (`suite`; no published port), because `POSTGRES_PASSWORD` is not set in `.env`.
2. ~~**Redis (layer 2).**~~ **Deferred to layer 3, 2026-10-29** (see "Layer 2: Redis"): the queries it would cache
   cost 1 to 10 ms and are polled every 30 s. Multi-user (layer 3) is pinned behind the deployment and the Google
   sign-in (item 4 below), so nothing here is next until the user says so.
3. When spellings arrive: lexicon → regenerate notes + minutes for `20260812_102457` → rebuild both
   Docs → trash the superseded ones (ask first).
4. **Pinned (2026-10-14, the user's call; not started).** Deploy to the instance: nginx on the host
   (containers stay on 127.0.0.1) with the page on one port and the API on another, as the Tailscale
   setup did; proxy buffering off and no body limit for the event stream and uploads; no access log
   for `/api/events` (its `?token=` would be written to it); basic auth on the page's origin only,
   because a CORS preflight carries no credentials, so the API stays behind its token; a self-signed
   certificate. Then the Google sign-in (`assistant/CLAUDE.md`, "Authentication"), whose first step is
   to see whether Google accepts a redirect URI there. Through an SSM tunnel the page is on
   `localhost`, which Google does accept.
5. Give `assistant-cli` the document tools too, or say in its README that drafting is web-only.
6. docu-ai: continue numbering across a split list (reuse the list id), and indent notes' quotes
   by border inset — both are docu-ai changes, so confirm with the user first (they asked once
   that a minutes problem not be "fixed" in docu-ai when docu-ai wasn't the cause).
7. meet-ai: speaker enrollment (its `plan.md`, M3b).
8. audiobook: ~~a way to delete finished audio and uploaded books~~ (built 2026-10-30); list `~/Documents/books/` as a library;
   let chat teach corrections from what the user says it misread (the tool already has the operation).
9. Close the gaps from 2026-10-24 ("Gaps found on 2026-10-24" above), in step order, once decisions
   9–10 under "Waiting on the user" are answered. Decision 8 (web-ai) is answered: yes, driven by
   the job application workflow (see above), and **web-ai is built (2026-10-28)**. Still open in that workflow:
   ~~the descriptions that wire the steps together~~ (built 2026-10-30, with files by path),
   and ~~the end-to-end run on a real application, through the model~~ (done 2026-10-30). Decisions 11 and 12 are about web-ai. The user asked for the plan on 2026-10-24.

## Picking this up in a new session

1. Read `CLAUDE.md` here, then the `CLAUDE.md` of whatever tool you will touch.
2. `./test` — everything must pass with no credentials.
3. `./start` (which runs `./start-docker up`), open http://127.0.0.1:8751/, and look at
   **Buttons → Settings**: model login, network, and each tool's last call. An expired login is the
   usual first failure: `./auth --check` says which, and the user renews it with `./auth`.
4. Check "Waiting on the user" above before starting anything it lists.
