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
  malformed store loads as empty.
- **Memory is background, not instruction.** It is framed that way in the prompt because a
  remembered line is data the user wrote once, not an order outranking what they say now.
- **Both memory tools are gated.** Writing about a person should be visible as it happens.

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
- **Security:** 127.0.0.1 only, never 0.0.0.0; a per-launch token on every `/api` request;
  Host must be localhost. The token may appear in a URL only for `/api/events`, because
  EventSource cannot send headers.

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

A CV is built with `docu_ai__build` and `theme: "resume"`, which docu-ai's model door now offers.

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
