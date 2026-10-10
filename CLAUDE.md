# suite — rules for the whole folder

**Start here: `plan.md`** holds the current state — what is built, what is rough, what is waiting
on the user, and the next steps. This file holds the rules. Read both before changing anything.

Each tool's own `CLAUDE.md` holds its engineering rules and gotcha ledger, and wins for anything
inside that tool. **This file covers only what is true across them.** Read the tool's file before
changing the tool.

## Commands

    ./setup    # idempotent: shared .venv, audiobook's own .venv, npm ci for docu-ai and the web app, speaker models
    ./start    # backend (API, :8750; launches every tool over MCP stdio) + web app (:8751)
    ./start-docker up [--tailscale]   # the same in containers; reachable from your other devices
    ./test     # all six test suites. Must pass with no credentials, no model, no network

## The web app and the backend are separate programs

`web/` is the frontend: its own folder, packages, build and server (`web/serve`, port 8751).
`assistant/` is the backend: an API on port 8750 that serves no page. They meet only over HTTP,
across origins, with one access token — never an import, a shared build, a proxy, or a page the
backend hands out. `./start` makes the token (random per launch), gives it to both, and the web
app's server writes it into the page; nobody pastes it. `./start` runs both side by side and
stops both when either stops. See `assistant/CLAUDE.md` for what the split forced (token hand-over,
CORS ordering).

## One folder, not one program

The tools share a folder, an install and a start command. **They do not share a process, a
module or a credential**, and keeping it that way is the point of the whole rebuild:

- **No tool imports another.** Tools meet only through the assistant, over MCP, as child
  processes. personal-ai's modules shared one process and quietly came to import each other's
  auth; separate processes are what make that impossible rather than merely discouraged.
- **A crash or a hang stays inside one tool.** docu-ai is TypeScript and could not share a Python
  process anyway; transcription pins every core for hours and must survive a server restart.
- **Credentials stay with their tool** (`~/.config/docu-ai`, `~/.config/mail-ai`, and audiobook's
  Hugging Face token in `audiobook/.env`, which is not the suite's `.env`). The assistant
  holds only its own model login, and reads a tool's health from how its calls went, never from
  its token files.
- **Every tool still runs alone.** Its wrappers use the tool's own `.venv` if it has one, and
  the suite's `../.venv` otherwise (audiobook has no such fallback: it needs its own) — so a tool
  checked out by itself works unchanged.

## The shared Python environment

assistant, meet-ai and mail-ai share `.venv`. `./setup` installs all three tools'
`requirements.txt` into it and runs `pip check`. **audiobook does not** (2026-10-10): it has its own
`audiobook/.venv`, built from its own pinned `requirements.txt`, because torch, Docling and Pocket
TTS are 1.9 GB that nothing else uses (the shared one is 696 MB) and torch must come from PyTorch's
CPU index, not PyPI's CUDA build. It was the weight and the index, not a version conflict — they
shared only fastapi, uvicorn, starlette, numpy, pydantic and huggingface_hub, at patch-level
differences. `audiobook/mcp` prefers its own `.venv` and does not fall back to the suite's.

**A pin that conflicts across tools is a
decision, not a merge accident**: if two tools need different versions of one package, the
answer is that tool getting its own `.venv` again (its wrappers already prefer one), never a
loosened pin.

Measured when the suite was formed (2026-09-27): the three tools pinned only `anthropic` in
common, at the same version; installed transitive deps differed only by patch (`idna`,
`protobuf`). 696 MB shared versus ~900 MB across three environments.

## In containers (`start-docker`, `compose.yaml`, `docker/`)

The suite also runs in Docker, which is how it is reached from a phone or another computer (Tailscale;
`README.md` has the steps). The rules:

- **One backend image holds the backend and every tool; the web app is a second image.** The tools are
  the backend's own child processes over MCP on stdio, and a container boundary is not a reason to
  change that. The web app stays a separate program with its own image. `init: true` is not optional:
  detached renders and transcriptions are reparented to PID 1, which must reap them.
- **All state is in `./data`** (git-ignored, owned by you, not by Docker's root): each tool's path comes
  from an environment variable in `compose.yaml`, which is the suite's own rule that paths are injected.
  audiobook is the exception, because it reads no setting for where its folders are, so the image
  symlinks `voices`, `output`, `.cache` and `.env` into `/data/audiobook`. `start-docker import` copies
  what the host folders already hold, once, never overwriting.
- **Nothing is published beyond `127.0.0.1`**, and the backend and web app listen on `0.0.0.0` *inside*
  the container network only (`ASSISTANT_HOST`, `WEB_HOST`). That is the one deliberate relaxation of
  "bind to localhost"; the token and the Host check still apply to everything. Reaching it from
  elsewhere is the Tailscale sidecar's job (`--tailscale`), not a published port's.
- **Hosts are exact names** (`ASSISTANT_HOSTS`, shared by both programs; `SUITE_HOST` in `.env`), never a
  pattern or `*`: the Host check is what stops a hostile page pointing its own name at this machine.
- **No source is mounted over the image.** A change to the code is live after `./start-docker up`
  (layer-cached, so only what changed is rebuilt). The images hold no credentials; they come in as the
  `./data` and `~/.aws` volumes.
- **A container restart interrupts a running render; a process restart does not.** On the host a job
  outlives the backend because it is a detached process nobody owns. In a container every process dies
  with the container, so `./start-docker up` (which recreates it) or a `docker compose restart` leaves
  a running render `interrupted` — honestly, and with every spoken sentence kept: start it again and it
  resumes. Verified. Don't deploy while a long render is going.
- **`./test` must pass with no network and an empty model cache**, and it once did not: a meet-ai test
  built the real 1.5 GB Whisper model and passed only because the developer's cache held it. Check it
  clean-room, in the image: `docker run --rm --network none -e HF_HOME=/tmp/empty-hf -e HOME=/tmp/h
  --entrypoint bash suite-backend -c 'cd meet-ai && ../.venv/bin/python -m pytest tests -q'` (and the
  other tools). `./start-docker test` runs every suite in the image, with docu-ai's corpus mounted
  because one of its tests reads a fixed path in the author's home folder.
- **What was run for real, and what was not:** see `plan.md` ("Built and verified"). The Tailscale
  sidecar needs a tailnet to run against, which cannot be faked.

## Settings

`.env` (from `.env.example`, never committed) is read by `./start` and exported, so every tool
inherits it. It holds only what is genuinely suite-wide: the AWS profile and region, the port.
A tool's own paths stay in `assistant/tools.yaml`, the one file that knows every tool exists.

## Working in this repo — rules learned the hard way

- **Stage by explicit path, never `git add -A`.** `docu-ai/plan.md` carries the user's own
  uncommitted edit; it has been kept out of every commit and must stay out unless they ask.
- **Commit as the user**: this machine has no git identity configured, so use
  `git -c user.name=Philip -c user.email=philip@ayadata.ai commit …`, with the co-author line.
- **Tools are launched once, when the backend starts.** A change to meet-ai, docu-ai or mail-ai
  (or to the backend) is not live until the backend restarts. The web app is different: its
  server serves `web/dist` live, so `cd web && npm run build` updates a running app.
- **Restart by stopping the backend**: `pkill -f "m assistant[.]server"` — `./start` then stops
  the web app too — and run `./start` again. The brackets matter: an unbracketed pattern such as
  `pkill -f "vite preview"` matches the shell running it and kills that instead. **The pattern must
  not appear anywhere else in the command you run**: the whole command text is the shell's own
  command line, so `pkill -f "vite[ ]preview"` still kills it whenever the same command also
  contains `vite preview` (a heredoc that writes the script counts). Put it in a script file and
  run `bash script` as its own command. Tripped over three times in one session.
- **Drive the chat the way the page does** to test it: the token is in the served page
  (`curl -s http://127.0.0.1:8751/` → `<meta name="assistant-token">`); POST `/api/chat`, poll
  `/api/state` for events and pending approvals, answer with POST `/api/approvals/{id}`. Read a
  pending draft's full `arguments` before approving it — never approve blind.
- **Check the interface in a real browser**: Puppeteer (`puppeteer-core`) against
  `/usr/bin/google-chrome-stable`. Chrome's own headless screenshot flags break on the event
  stream (`assistant/CLAUDE.md`).
- **A live test that builds a Google Doc leaves a real Doc** in the user's Drive: trash it after,
  and delete test uploads from `assistant/uploads/`.
- **A live audiobook test leaves a book's worth of audio** in `audiobook/output/<pdf name>/`, named
  for the PDF — so upload a *copy* under a throwaway name (`zz-test-paper.pdf`), never the real
  book's name, or a test render overwrites the user's finished chapters. Delete the output folder,
  the upload, and the `.corrections.txt` a test leaves beside it. A render is a detached process:
  restarting the backend does not stop it (and the restarted backend sees it), so `pkill` it
  explicitly if a test render must end.
- **The model login lapses overnight** (AWS SSO). Settings shows it; only the user can renew it
  (`aws sso login --profile ayadata-bedrock`, needs a browser).
- **Done means run for real and looked at.** Unit tests passed on every change this suite has had;
  the real runs are what found the dropped quotes, the 8-page minutes, the truncated CV draft and
  the cut-off approval preview. Build it, run it, open the output.

## History

Each tool was its own repo until 2026-09-27; their histories were rewritten into these folders
and merged, so `git log -- docu-ai/src/...` and `git blame` show the real commits. audiobook joined
the same way on 2026-10-10 (four commits, `98c60e3`), with its own web app removed afterwards.
