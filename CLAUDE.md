# suite — rules for the whole folder

**Start here: `plan.md`** holds the current state — what is built, what is rough, what is waiting
on the user, and the next steps. This file holds the rules. Read both before changing anything.

Each tool's own `CLAUDE.md` holds its engineering rules and gotcha ledger, and wins for anything
inside that tool. **This file covers only what is true across them.** Read the tool's file before
changing the tool.

## Commands

    ./setup    # idempotent: shared .venv, npm ci for docu-ai and the web app, speaker models
    ./start    # backend (API, :8750; launches every tool over MCP stdio) + web app (:8751)
    ./test     # all five test suites. Must pass with no credentials, no model, no network

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
- **Credentials stay with their tool** (`~/.config/docu-ai`, `~/.config/mail-ai`). The assistant
  holds only its own model login, and reads a tool's health from how its calls went, never from
  its token files.
- **Every tool still runs alone.** Its wrappers use the tool's own `.venv` if it has one, and
  the suite's `../.venv` otherwise — so a tool checked out by itself works unchanged.

## The shared Python environment

assistant, meet-ai and mail-ai share `.venv`. `./setup` installs all three tools'
`requirements.txt` into it and runs `pip check`. **A pin that conflicts across tools is a
decision, not a merge accident**: if two tools need different versions of one package, the
answer is that tool getting its own `.venv` again (its wrappers already prefer one), never a
loosened pin.

Measured when the suite was formed (2026-09-27): the three tools pinned only `anthropic` in
common, at the same version; installed transitive deps differed only by patch (`idna`,
`protobuf`). 696 MB shared versus ~900 MB across three environments.

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
  `pkill -f "vite preview"` matches the shell running it and kills that instead.
- **Drive the chat the way the page does** to test it: the token is in the served page
  (`curl -s http://127.0.0.1:8751/` → `<meta name="assistant-token">`); POST `/api/chat`, poll
  `/api/state` for events and pending approvals, answer with POST `/api/approvals/{id}`. Read a
  pending draft's full `arguments` before approving it — never approve blind.
- **Check the interface in a real browser**: Puppeteer (`puppeteer-core`) against
  `/usr/bin/google-chrome-stable`. Chrome's own headless screenshot flags break on the event
  stream (`assistant/CLAUDE.md`).
- **A live test that builds a Google Doc leaves a real Doc** in the user's Drive: trash it after,
  and delete test uploads from `assistant/uploads/`.
- **The model login lapses overnight** (AWS SSO). Settings shows it; only the user can renew it
  (`aws sso login --profile ayadata-bedrock`, needs a browser).
- **Done means run for real and looked at.** Unit tests passed on every change this suite has had;
  the real runs are what found the dropped quotes, the 8-page minutes, the truncated CV draft and
  the cut-off approval preview. Build it, run it, open the output.

## History

Each tool was its own repo until 2026-09-27; their histories were rewritten into these folders
and merged, so `git log -- docu-ai/src/...` and `git blame` show the real commits.
