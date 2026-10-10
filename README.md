# suite

An assistant and the tools it runs, in one folder, started with one command.

Where it stands and what comes next: [`plan.md`](plan.md). Rules for working on it:
[`CLAUDE.md`](CLAUDE.md).

| Folder | What it does |
|---|---|
| `web/` | The web app you open: chat and buttons, uploads of audio, markdown, PDFs. A separate program that calls the backend's API. |
| `assistant/` | The backend. Starts the tools below, calls them for you, asks before anything that writes. |
| `meet-ai/` | Records meetings, transcribes them on this machine, writes notes and minutes that cite the recording. |
| `docu-ai/` | Turns markdown into a properly formatted Google Doc. |
| `mail-ai/` | Reads, searches, drafts and sends Gmail. |
| `audiobook/` | Turns a PDF into an audiobook, read in a voice cloned from a short recording. Runs entirely on this computer. |

## Architecture

Six programs, not one. They share a folder, an install and a start command — nothing else.

- **The web app and the backend are separate programs.** `web/` is a frontend: its own build, its
  own server, port 8751. `assistant/` is an API with no page of its own, port 8750. They only ever
  meet over HTTP, across origins — never an import, a shared build, or a page one hands the other.
  `./start` makes a fresh access token each launch and gives it to both; the web app's server writes
  it into the page as it serves it, so nothing is pasted by hand.
- **The backend starts the four tools as its own child processes**, talking to each over MCP on
  stdio — the same protocol a model uses to call them. `meet-ai`, `docu-ai`, `mail-ai` and
  `audiobook` each also work standalone, from their own folder, with nothing else running.
- **No tool imports another, and no tool imports the backend.** They meet only through the
  backend's tool calls. A crash or a multi-hour transcription in one tool cannot take down another,
  or the backend, or the web app.
- **Every write is gated.** The backend classifies a tool's own call as read-only or not (from the
  tool's own annotation, never a list it keeps itself) and asks a person before anything else runs —
  sending mail, building a Doc, changing a recording. A poll or a read needs no approval; a write
  does, every time, and every call is written to an audit log.
- **Credentials stay with their tool.** docu-ai's Google login and mail-ai's Gmail login live in
  their own `~/.config` folders; the backend holds only its own model login and reads a tool's
  health from how its calls went, never from its token files.

The rules behind each of these, and why they're rules, are in [`CLAUDE.md`](CLAUDE.md); each
tool's own architecture — its layers, its verified API facts, its gotchas — is in that tool's own
`CLAUDE.md`.

## First time

```bash
./setup          # the Python environments, Node packages, the web app, speaker models
```

Then the logins `./setup` lists: Google for docu-ai (`cd docu-ai && npm run auth`) and for
mail-ai (`mail-ai/mail auth`, plus `--compose` to draft and send), and AWS for the model
(`aws sso login --profile <profile>`). Settings go in `.env`, which `./setup` creates from
`.env.example`.

## Every day

```bash
./start          # then open http://127.0.0.1:8751/
```

One command, two programs: the backend (API on port 8750, which launches the four tools as
its own children) and the web app (port 8751). Stopping either stops both. A transcription or
recording in progress is built to outlive a restart and is picked up again next time.

Nothing to sign in to: `./start` makes a fresh access token each launch, gives it to both
programs, and the web app's server puts it in the page. A tab left open across a restart picks
up the new one by itself. **Buttons → Settings** shows whether the model login, the network and
each tool are working.

Each half also runs alone: `assistant/assistant-web` for the backend, `web/serve` for the app
(or `cd web && npm run dev` for live reload). Run that way without a shared `ASSISTANT_TOKEN`,
the app asks once for the token the backend prints.

```bash
./test           # every tool's tests; none needs a login, a model or the network
```

## Each tool still stands alone

Every tool keeps its own command line, tests and rules (`CLAUDE.md`, `plan.md`), and works
from its own folder with the assistant not running: `meet-ai/notes`, `mail-ai/mail`,
`cd docu-ai && npm start`, `cd audiobook && .venv/bin/python -m audiobook preview BOOK.pdf`. See each
folder's README or `CLAUDE.md`.

**Audiobooks** are a long job: reading a book takes minutes and rendering one takes hours. Both run in
the background, survive restarting the backend, and show their progress under **Buttons → Audiobooks**.
audiobook is the one tool with its own Python environment (`audiobook/.venv`, ~1.9 GB), and its Hugging
Face token lives in `audiobook/.env`.
