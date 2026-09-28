# suite — rules for the whole folder

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
across origins, with the access token the backend prints at launch — never an import, a shared
build, a proxy, or a page the backend hands out. `./start` runs both side by side and stops
both when either stops. See `assistant/CLAUDE.md` for what the split forced (token hand-over,
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

## History

Each tool was its own repo until 2026-09-27; their histories were rewritten into these folders
and merged, so `git log -- docu-ai/src/...` and `git blame` show the real commits.
