# assistant — engineering rules

The smallest component in the suite. It classifies, calls, gates, and logs. **No domain
logic, ever** — if a change here needs to know what a timeline or a heading index is, it
belongs in a tool instead.

## Boundaries

- **Never import from a tool's repo.** The provider seam in `config.py` is a deliberate
  copy of meet-ai's, not an import. Sharing code across a repository boundary is how a suite
  of independent tools quietly becomes a monolith again — which is the exact failure this
  whole architecture was a response to. A little duplication at a boundary is the cheaper
  mistake.
- **`tools.yaml` is the only file that knows every tool exists.** Adding a tool is an entry
  there; no module gets edited. (The one exception is `watchers.py`, which names the tools whose
  long jobs deserve a "finished" notice: meet-ai's transcription and audiobook's jobs.)
- **Credentials and paths are injected into tools, never discovered by them.** The `env` on
  a server entry is that mechanism.

## The gate

- Approval is decided from the tool's own `readOnlyHint`, never from a list here.
- **Absent annotations fail closed.** A tool that forgot to annotate itself must not get a
  free pass; `read_only=bool(annotations and annotations.read_only_hint)`.
- Anything that is not an explicit `y`/`yes` is a decline.
- **The model must not ask permission in prose.** The system prompt says so explicitly.
  Without that, you get two gates: the model asks, the user answers the model, and the turn
  ends before the gate ever fires. Found live at M0 — the first two runs of a two-tool chain
  both stalled this way.

## MCP SDK — two traps, both sprung

**mcp 2.x exposes snake_case attributes and keeps camelCase only as a wire alias.** The
Python objects have `input_schema` and `is_error`; `inputSchema` and `isError` are the
aliases. Reading an alias off the object does not raise — `getattr(result, "isError", False)`
returns the default — so **every tool failure was silently recorded as a success** until a
real `invalid_grant` made it visible. Check the field list before reaching for a name you
remember:

    .venv/bin/python -c "from mcp.types import CallToolResult; print(list(CallToolResult.model_fields))"

**An exception raised while starting servers hangs the process instead of surfacing.**
`ToolRegistry.__aenter__` builds an `AsyncExitStack` of child processes; a failure part-way
through leaves them attached to a half-built stack and the program deadlocks with no
traceback at all. The `except BaseException: await self._stack.__aexit__(*sys.exc_info());
raise` around that loop is what turns a silent hang into an error message. It cost an hour
to find once — an `AttributeError` from the rename above, presenting as a hang.

## Memory

- **It is the assistant's own state, and no tool may read it.** Tools take what they need as
  arguments. The moment a tool reaches into memory, it stops being usable alone and the suite
  has a shared mutable centre again.
- **Not pgvector, on purpose.** Everything fits in a prompt at this scale, and sending all of
  it is more accurate than any retrieval. `relevant()` is the seam; narrow it only when the
  prompt genuinely gets too big.
- **Memory failing degrades what the assistant knows, never whether it runs.** A missing or
  malformed file loads as empty; a turn whose memory cannot be read (the database went away) goes ahead
  with the context it already had (`Hub.run`).
- **Memory is background, not instruction.** It is framed that way in the prompt because a
  remembered line is data the user wrote once, not an order outranking what they say now.
- **Both memory tools are gated.** Writing about a person should be visible as it happens.

## The database (`db.py`, `migrations/`)

Memory, the audit log and sign-in sessions live in PostgreSQL when `DATABASE_URL` is set, which only the
container setup does (`compose.yaml` builds it). Unset, they are the files they were -- `memory.json`,
`audit.jsonl`, sessions in a dict -- and that is what every test uses, so `./test` needs no database. Each
is an abstract store with two implementations (`MemoryStore`, `AuditStore`, `SessionStore`), and **every
store method is `async`**, which is why `LocalTool.handler`, `prepare`, `context_for`, `tools_status` and
`audit.record` are too. Raw asyncpg and plain SQL, no ORM, no Alembic.

- **Migrations are numbered files, applied once, never edited.** `migrate()` runs every file in
  `migrations/` not yet in the `migrations` table, each in its own transaction (a half-applied file leaves
  nothing and is retried), under an advisory lock. A change to the schema is a new, higher-numbered file.
- **`users`, `dossiers` and `dossier_refs` exist and nothing uses them.** They are the schema multi-user and
  dossiers will need (`../plan.md`), laid down so those are not a migration of live data. `user_id` is
  nullable on `facts` and `audit_log` until then.
- **The old files are imported once, then renamed `*.imported`** (`import_legacy_files`, on connect). Facts
  merge by id; the audit log is imported only into an empty table, so a file that could not be renamed is
  not imported twice. A fact whose kind the table refuses (a hand-edited file) is kept as `fact`. Nothing is
  deleted: to go back, rename the files and drop the database.
- **The stores read the pool when called, not when built**, so `create_app` builds them before the event
  loop exists and the lifespan connects. `app.state.database` is how `main()` prints which store is in use.
- **A tool must never get the database address.** Tools inherit the backend's environment, so
  `tool_environment()` removes `DATABASE_URL` (`WITHHELD_FROM_TOOLS`). Note that it does not remove the other
  secrets the backend holds (`ASSISTANT_TOKEN`, `GOOGLE_CLIENT_SECRET`): they were inherited before and still are.
- **Failure modes follow the rules above.** `audit.record` never raises (a failed write is logged);
  audit reads that fail return nothing; a session lookup that fails is "not signed in" (the guard must answer,
  not crash); a memory write that fails raises, so the tool reports it.

Four things worth knowing, each checked directly against a real server (2026-10-28):

- **Facts keep their order through `updated_at`, which defaults to `clock_timestamp()`, not `now()`.**
  `now()` is one value for a whole transaction: six facts inserted as f e d c b a came back a b c d e f
  with `now()` (they tied, and the id broke the tie) and f e d c b a with `clock_timestamp()`. The import
  writes every fact in one transaction.
- **A subject is matched with Python's `lower()`, not SQL's.** SQL's follows the database's locale. In this
  image's `en_US.utf8` the two agree on `AYÉ`; in a database made with the `C` locale SQL gives `ayÉ` and a
  name with an accent would stop matching its own correction. Matching in Python is the same in every locale.
- **An asyncpg pool belongs to the event loop it was made in.** Used from a second `asyncio.run` it fails with
  `InterfaceError: another operation is in progress`. The tests therefore run each Postgres scenario inside
  one `asyncio.run`, and do not share a store across calls.
- **The postgres container runs as your uid, not its own.** Without `user:` the data folder on the host is
  owned by uid 70 and cannot be deleted or moved without sudo. The image needs the uid to exist in
  `/etc/passwd`, so compose mounts the host's, read-only.

Testing it: `tests/test_database.py`. The Postgres tests skip unless `TEST_DATABASE_URL` names a server they
may create databases on (each test makes one and drops it), so point it at a throwaway:
`docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine`, then
`TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres ../.venv/bin/python -m pytest tests/test_database.py`.

## Honest reporting

- **A tool reporting its own failure is a failure.** MCP returns that as `is_error` on an
  otherwise successful response, not as a raised exception. An audit log that records a
  failed build as `ok` is worse than no audit log.
- The audit log never raises. A broken log must not break the work.

## The web server

- **Chat and buttons are one state.** A button that changes something becomes a note handed
  to the model with the next message; a model's action streams to every view. Two apps that
  happen to share a backend would let "stop the recording" and "write it up" refer to
  different things.
- **Notes are held until a turn boundary.** Appended mid-turn, a note would sit between a
  tool call and its result, and the model's API rejects that shape.
- **Every call takes `session.execute`,** chat or button. Two paths would drift — the button
  one would quietly lose its audit row or its preview the first time only the other changed.
- **A failed turn rolls the conversation back** to before it, keeping the button notes. A
  turn that dies mid-way can leave a tool call without its result, which poisons every
  later turn.
- **Status polls from buttons are not noted.** Only calls that change something are; a poll
  every few seconds would bury the model's context.
- **Security:** 127.0.0.1 unless `ASSISTANT_HOST` says otherwise (only the container setup does, inside
  its own network, with the port published to 127.0.0.1 and a Tailscale sidecar, never to the world; it
  prints that it is not localhost-only); a token on every `/api` request; Host must be localhost or an
  exact name in `ASSISTANT_HOSTS` (parsed by `parse_hosts`: names only, never patterns). The token may
  appear in a URL only for `/api/events`, because EventSource cannot send headers. Who may use the API
  is decided in one function, `authenticate()`.

## The interface is a separate program (`../web`)

**This server is the API only.** The web app lives in the suite's top-level `web/`, is served
by its own process on its own port (8751; Vite's dev server on 5173), and calls this API across
origins. Separated completely on 2026-09-28. What that cost, and what it forced:

- **This server can no longer inject the token into the page**, since it serves no page. The
  first answer was a paste-the-token Connect screen, and it was rejected on sight: a step every
  launch is a cost nobody should pay for a local app. Now `../start` makes the token (random,
  per launch) and gives it to both programs, and the *web app's* server injects it at serve time
  — the same protection as before, moved to the program that serves the page. It must check
  `Host` itself (Vite's own check may run after it), send `no-store`, and never bake the token
  into `dist/`. A refused token makes the app re-fetch its own page and reload if the token
  there changed; the Connect screen remains only for the halves run separately with nothing
  shared. Google login was considered and is the wrong tool here: it proves *who*, and on one
  machine with one user the only question is whether a request comes from this app.
- **CORS is added after the token guard, so it runs outside it.** A browser's preflight
  carries no token and would otherwise be refused before CORS could answer; and the guard's
  own 401 needs CORS headers, or the browser hides the status and the app cannot tell "paste
  the new token" from "the server is down". Both are tested. Only `ASSISTANT_ORIGINS` (default:
  the web app's two origins) may read responses; the token is still required regardless.
- **No proxy.** Vite used to forward `/api` to this server, which quietly kept the two joined;
  the app now calls `VITE_API_URL` directly, the same in development as in use.

The web app itself: Vite + React + strict TypeScript. One state for both modes (`state.tsx`), fed by one event stream; the modes are views, never
separate stores. Assistant replies render as Markdown through react-markdown, which does not
render raw HTML — and approval previews are rendered as text, never markup, because they are
email bodies and transcripts someone else wrote.

Four things that only showed up by running it:

- **The event stream must send bytes the moment it opens.** EventSource fires `onopen` only
  when the first bytes arrive, and the server sent nothing until the first event or the
  15-second keepalive — so every page load showed "reconnecting" and disabled the message box
  for up to 15 s. An immediate `: connected` comment brought first byte to 6 ms.
- **uvicorn needs `timeout_graceful_shutdown`.** It waits for open connections to drain before
  stopping, and an event stream never drains — any open browser tab blocked shutdown forever,
  holding the three tool processes with it.
- **Memory is re-read every turn.** The server runs for days; a fact remembered mid-session
  must reach the next turn, not the next restart.
- **Headless Chrome cannot screenshot this page with `--virtual-time-budget` or `--timeout`.**
  The first waits for network idle, which an event stream never reaches; the second works by
  stopping all network activity, which kills the stream and makes the page report
  "reconnecting" — corrupting exactly what it is measuring. Drive a real browser session
  (Puppeteer against the installed Chrome) instead.

## Uploads

Audio to transcribe and markdown to build into a Doc arrive at `/api/uploads/*` and land in
`uploads/` (never committed; `ASSISTANT_UPLOADS` moves it). **An upload ends in a path, and a
path is all any tool takes** — so meet-ai and docu-ai did not change and do not know uploads
exist. The same file works from a button or from chat.

- **The request body is the file**, streamed to disk; nothing is buffered whole, and no
  multipart parser is involved. The web app uses XMLHttpRequest, not fetch, for these: only it
  reports upload progress.
- **Every name is hostile.** Each path component is checked, the result must resolve inside
  `uploads/`, a repeat name becomes `name (2).ext`, and a file is written to `.part` and renamed
  only once complete — a half-received recording is never listed or transcribed. Tested.
- **Markdown arrives as a batch** named for the uploaded folder (or file), because docu-ai uses
  the folder's name as the Doc's default title. One file builds as a file (one tab, no cover);
  several as a folder. docu-ai reads only a folder's top level, so the web app sends only
  top-level `.md` files and lists the rest as skipped, rather than uploading files that would
  silently do nothing.
- **Each upload is noted for the model** with the next message, like a button press — which is
  what makes "transcribe what I just uploaded" work, from either mode.

## Drafting documents (`documents.py`)

`list_uploads`, `read_document` and `write_draft` let the model change what a document *says* —
tailor a CV, rewrite a report — which it could not do before: asked to "create a CV for an ML
engineer role" it formatted the upload as it was and replied as though it had tailored it. Local
tools, like memory, because the uploads folder is the assistant's own state. Four rules, each
from something that went wrong live:

- **A draft is always a new file.** The original must survive to be compared against.
- **The approval shows the draft rendered, whole.** A local tool can now `render` its own
  preview; a document as a JSON string cannot be reviewed. And the browser's approval preview is
  no longer cut at the terminal's 4,000 characters (`WEB_PREVIEW_LIMIT`): a CV's approval
  stopped mid-word there, hiding Skills, Education and Certifications from the person approving.
- **A rewrite is measured against its original.** With `based_on`, the approval opens with the
  sections missing and points kept, and the model is told the same. A first "tailored" CV
  silently ended after its first project — 7 of 18 points — while the model said it had only
  reordered. The prompt already asked for honesty; the count is what caught it.
- **Say what was and was not done.** The system prompt now requires it, and forbids inventing
  experience, employers, dates, qualifications, figures or skills.

- **A draft is marked as the assistant's own** (2026-10-15). `write_draft` drops a `.draft` file beside it and
  `list_uploads` reports `draft: true`. A check that compares a new draft with "the user's own material"
  (apply-ai) refuses a marked folder: on a second application the model passed its own earlier cover letter
  as a source, and a claim it had made would have been supported by itself. A convention in a filename, not an
  import. Drafts written before the marker have none (add `.draft` by hand).

A CV is built with `docu_ai__build` and `theme: "resume"`, a cover letter with `theme: "letter"` (a letter in the
CV look came out cramped, in the report look it ran onto a second page), both of which docu-ai's model door offers.

**What runs around a draft, and where it lives.** Before drafting, `apply_ai__requirements` sets the posting
against the material and the model asks every gap in one message; after drafting, `apply_ai__claims` traces the
draft's claims to source lines; after saving, `docu_ai__build` returns a page count and layout warnings and
`docu_ai__trash` clears the Doc a rebuild replaces. **None of that is in the system prompt**: it is in those
tools' own descriptions, which is where "no domain logic, ever" puts it. A real run followed it with no prompt
change. `MAX_TOOL_ROUNDS` is 30 for it: 12 stopped a legitimate tailoring mid-trim, with the answer to the
user not yet written (found live, 2026-10-15).

## Books and voices (audiobook)

`PUT /api/uploads/book` takes a PDF into `uploads/books/`, and `PUT /api/uploads/voice` a recording
to clone a voice from into `uploads/voices/` — **apart from `audio/`, which is meetings**, so a voice
sample never shows up as something to transcribe. Same rules as every upload: hostile names,
`.part` then rename, a path is all the tool gets, and each is noted for the model. The tool is
`audiobook`; the assistant knows nothing about books.

## Audio a tool made (`GET /api/files`)

How the web app plays and downloads what a tool rendered, without the assistant learning where any
tool keeps anything. Five rules, the first four tested in `tests/test_uploads.py`:

- **A tool declares what may be served, in `tools.yaml`** (`files: [output]`, relative to the tool's
  own folder). The API serves only audio files inside a declared folder; the registry's
  `media_roots` is the whole list.
- **The check is on where the file really is.** `resolve()` follows symlinks and `..` before the
  folder test, so a link inside `output/` that points outside it, or `output/../x.mp3`, is refused.
- **Only audio extensions** (`MEDIA_TYPES`): a declared folder is not a licence to send `.env`.
- **Every refusal is the same plain 404** — outside the folders, wrong kind, missing — so the answer
  says nothing about what exists elsewhere.
- **The token stays out of the URL.** Its rule is still "a URL only for `/api/events`", because
  EventSource cannot send headers; an `<audio>` tag could, but only by putting the token in its
  `src`, where it is kept in logs and history. So the web app `fetch`es the file with the header and
  plays a blob (`web/src/api.ts` → `fetchMedia`). The cost is that a file loads whole before it
  plays: a four-hour M4B is ~115 MB. Taking that over a token in a URL was deliberate.

## Authentication: what a Google sign-in changes

The next big feature, scoped here so the container and Tailscale setup would not have to be redone for
it. **Not built.** Today `authenticate(request)` accepts the launch's token; signing in adds a second way
to be recognised there.

- **The shape.** OpenID Connect (authorization code + PKCE) done by *this* backend: `/auth/login`,
  `/auth/callback`, `/auth/logout`, and `/api/me` for the page to ask "who am I". Verify the ID token's
  signature, `iss`, `aud`, `exp` and `email_verified`, then require the email to be in
  `ASSISTANT_ALLOWED_EMAILS` (one address to begin with). The session is a random id in a server-side
  store, sent as `HttpOnly; Secure; SameSite=Lax`, with an expiry.
- **Its own Google OAuth client, scopes `openid email` only.** Not the clients docu-ai and mail-ai use:
  credentials stay with their tool, and the sign-in belongs to the assistant. Those scopes are
  non-sensitive, so no Google verification is needed. (The existing OAuth app is in "Testing", which is
  why the Docs and Gmail tokens expire weekly; that does not touch signing in.)
- **The topology is already right.** The page is at `https://<SUITE_HOST>` (443) and the API at
  `https://<SUITE_HOST>:8443`: one host, so one *site* and a `SameSite=Lax` cookie goes to both; two
  ports, so two *origins*, which means `allow_credentials=True` with the exact origin list (never `*`),
  `credentials: 'include'` on every fetch, and `withCredentials` on the EventSource. With that the
  `?token=` exception for `/api/events` can go. Keep requiring a custom header on state-changing
  calls so a cookie alone cannot be replayed by another site.
- **The page stops carrying a secret.** `WEB_INJECT_TOKEN=0` (already supported) and the app shows
  "Sign in with Google" when `/api/me` says 401. Decide at build time whether the token still works for
  `127.0.0.1` as a break-glass; it should not work over the tailnet once sign-in exists.
- **First step, before any code: does Google accept `https://<SUITE_HOST>:8443/auth/callback`?** Google
  wants redirect URIs on a public top-level domain and `*.ts.net` has not been tried. Register it in a
  test OAuth client and see. If it is refused, the options are a custom domain pointing at the tailnet
  node with its own certificate, or Tailscale's own verified identity headers (which `tailscale serve`
  adds for tailnet users) in place of Google. Don't build the rest until this is known.
- **One allowed account, not accounts.** Per-user data (`memory.json`, uploads, each tool's credentials)
  is the larger option (c) in `plan.md` and is not part of this.

## Deleting (2026-10-30)

Three things the person can delete from the web app, each only by a button they press, each audited
and asked about first (`web/src/ui/ConfirmDelete.tsx`). Run for real on throwaway files, in Chrome.

- **The chat** (`POST /api/chat/clear`). Clears what the model holds (`messages`), the button notes, and
  the conversation events (`is_conversation`: messages, replies, approvals, and tool calls made from chat)
  from the live history; keeps notices, uploads and a button's own result, which Overview and Activity
  list. It emits `chat_cleared` and every open page fetches the pruned history, so the rule lives only
  here. Chat itself shows nothing from before the last `chat_cleared`: a "You pressed" chip outlived the
  first clear (found live). Refused while a turn runs or an approval waits -- the turn holds an index into
  `messages`. Memory and the audit log are untouched; it is audited as `assistant__clear_chat`.
- **An upload** (`POST /api/uploads/delete`, `{kind, name}` as the listing gave them). No tool offers it,
  so a model cannot delete a person's files. The name is hostile, like an upload's: one component, a
  direct child of its kind's folder, only the extensions that kind is listed by (never a `.part`), and a
  markdown batch only if it holds plain files. **A link is refused outright**: a link to a sibling in the
  same folder resolves inside it, passes every location check, and the real file is what would go (a test
  pins it; the first version's tests passed without that check). Audited as `assistant__delete_upload`,
  noted for the model, and announced as `upload_deleted`. The assistant cannot tell that a file is in use
  (a recording being transcribed); the Meetings page hides its upload chips while a transcription runs.
- **A Google Doc or an audiobook** is the owning tool's: `docu_ai__trash` (to Drive's bin, its approval shows
  `info`) and `audiobook__delete_audiobook` (its approval shows `describe_audiobook`). The page fetches
  what will go with the read-only tool and calls the destructive one only on a confirmed press, never to
  find out what it would do.

## Stopping a reply (`POST /api/chat/stop`, 2026-10-31)

Chat had no way to stop a reply once sent. `Hub.request_stop` sets the turn's own `stop` event (a new one each turn,
so a stop never carries over) and answers no to any approval waiting. `run_turn` stops at the next safe point:

- **While the model thinks**, its request is raced against the stop; the answer, if it comes, is thrown away
  (the request's thread runs to its end on its own).
- **A tool already running is never cut off.** It finishes and is audited: stopping halfway through a change would
  leave it done but unrecorded. A tool the model asked for that has not started gets `STOPPED_TOOL` as its result.
- **The conversation is left whole**: every tool call answered, then one short assistant reply (`STOPPED_REPLY`),
  so the next message carries on. Run for real: a reply stopped while the model thought, then a new question was
  answered normally (the API took the conversation as it stood).
- `turn_stopped` is conversation (`CONVERSATION_EVENTS`), so Clear chat removes it.
- The check at the top of each round is a second guard: with it removed the race above still stops the turn before
  the next request goes out, so no test can tell the difference (a deliberate break of it survives). It is kept so
  that does not rest on the order asyncio runs tasks in.

Tools now carry their `title` (MCP's, or their annotations'), passed to the interface in `/api/tools` and in an
approval, so a person reads "Write a new draft" rather than "draft new". The model is still shown name and
description only.

## On a timer (`schedule.py`, 2026-10-30)

A tool's entry in `tools.yaml` may say `schedule: [{tool: sync, every_minutes: 30}]`, and the server runs that
tool, with no arguments, at start and then that long after each run ends, whether or not a page is open. Only
mail-ai's `sync` has one. It used to be a timer in the web page: a closed tab left the mailbox five days stale
(2026-10-24), and two tabs synced twice.

- **Declared, never known.** The server reads `registry.schedules`; nothing in it names mail. A wrong entry
  (no tool, an interval under five minutes, not a whole number) stops the server starting, because a schedule
  that silently never ran is the failure this replaced.
- **The path a button takes**, `session.execute` with the gate answered by the declaration (`allow_gate`), and
  the origin `schedule`, which History shows as "Schedule".
- **Audited when its outcome changes**, not every run: the first run, a failure, a recovery. A row every half
  hour pushed a person's own actions out of History and the Overview when the page's timer did it. The newest
  row per tool, which Settings reads for health, is still the current state.
- **Not conversation.** No events, no note for the model. It speaks only through a notice, once when it starts
  failing and once when it recovers. A run never overlaps the one before it; a failure never stops the timer.

Run for real: the first scheduled run after a rebuild, with no page involved, was a full re-sync (the
mailbox's sync point had lapsed) that took 5 min 34 s and added 1,040 messages. **Not handled:** a sync pressed
in Mail while the scheduled one runs reaches the same tool process at the same time, as two open tabs could
before.

## Memory and history in the interface

- **Facts in the prompt carry their ids.** `forget` takes an id; a prompt showing facts without
  them left the model no valid way to act on "forget that" — only a guess. `recall` lists them
  for the interface through the same audited tool path as everything else.
- **Reads triggered from the interface are not audited, and emit no events.** They are the page
  looking, and the panels poll every few seconds — auditing them buried the log under tens of
  thousands of status checks a day. The model's reads are still recorded.
- **The URL hash is followed on change, not just read on load.** A hash change does not reload
  the page, so reading it once left back, bookmarks and edited URLs showing the old section.

## Approval previews

- **A tool may declare, in `_meta`, the read-only tool that renders its effect.** The gate
  calls it and shows the result instead of the arguments. This exists because
  `send_draft(draft_id, confirmation)` cannot be approved from its arguments, and the
  assistant must not learn what an email is in order to fix that.
- **Verify the named tool is read-only before calling it.** Otherwise a tool could name a
  destructive "preview" and have it run before anyone approved anything.
- **Never fall back silently.** A declared preview that could not be produced is announced;
  otherwise it is indistinguishable from a tool that offered none, and someone approves a
  send believing they saw it.
- **Sanitise preview text.** It is untrusted content — an email body — printed directly
  above a yes/no prompt, where escape sequences could repaint the screen or fake the prompt.
  Strip C0/C1 controls except newline and tab, and cap the length so a huge body cannot
  scroll the call being approved off the screen.

## The gate, continued

- **A gate that cannot get an answer declines.** `input()` raises `EOFError` when stdin is
  exhausted — piped input that ran out, a non-interactive shell — and letting it propagate
  kills the turn mid-chain with writes already done. Found live: two approved writes landed,
  then a third call hit end-of-input and crashed the session. `KeyboardInterrupt` is a
  decline for the same reason.

## Testing

No model, no child process, no network. The gate carries the most tests: it is the only
thing between a model's intention and a write, and it must work without depending on a
model behaving well.
