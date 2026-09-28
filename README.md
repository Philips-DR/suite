# suite

An assistant and the tools it runs, in one folder, started with one command.

Where it stands and what comes next: [`plan.md`](plan.md). Rules for working on it:
[`CLAUDE.md`](CLAUDE.md).

| Folder | What it does |
|---|---|
| `web/` | The web app you open: chat and buttons, uploads of audio and markdown. A separate program that calls the backend's API. |
| `assistant/` | The backend. Starts the tools below, calls them for you, asks before anything that writes. |
| `meet-ai/` | Records meetings, transcribes them on this machine, writes notes and minutes that cite the recording. |
| `docu-ai/` | Turns markdown into a properly formatted Google Doc. |
| `mail-ai/` | Reads, searches, drafts and sends Gmail. |

## First time

```bash
./setup          # one Python environment, Node packages, the web app, speaker models
```

Then the logins `./setup` lists: Google for docu-ai (`cd docu-ai && npm run auth`) and for
mail-ai (`mail-ai/mail auth`, plus `--compose` to draft and send), and AWS for the model
(`aws sso login --profile <profile>`). Settings go in `.env`, which `./setup` creates from
`.env.example`.

## Every day

```bash
./start          # then open http://127.0.0.1:8751/
```

One command, two programs: the backend (API on port 8750, which launches the three tools as
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
`cd docu-ai && npm start`. See each folder's README.
