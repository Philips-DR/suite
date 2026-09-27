# suite

An assistant and the tools it runs, in one folder, started with one command.

| Folder | What it does |
|---|---|
| `assistant/` | The web app and chat. Starts the tools below, calls them for you, asks before anything that writes. |
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
./start          # then open http://127.0.0.1:8750/
```

One process to start and stop. The assistant's server launches the three tools as its own
children and they end with it — except a transcription or recording in progress, which is built
to outlive a restart and is picked up again next time. **Buttons → Settings** shows whether the
model login, the network and each tool are working.

```bash
./test           # every tool's tests; none needs a login, a model or the network
```

## Each tool still stands alone

Every tool keeps its own command line, tests and rules (`CLAUDE.md`, `plan.md`), and works
from its own folder with the assistant not running: `meet-ai/notes`, `mail-ai/mail`,
`cd docu-ai && npm start`. See each folder's README.
