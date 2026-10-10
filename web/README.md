# web

The assistant's web app: chat and buttons over one shared state. A separate program from the
backend (`../assistant`) — its own folder, its own server, its own port — that calls the
backend's API across origins.

```bash
./serve          # build if needed, serve on http://127.0.0.1:8751
npm run dev      # live reload on http://127.0.0.1:5173
```

The backend must be running for the app to do anything (`../start` runs both).

**Uploads:** audio from **Meetings → Upload audio**, markdown files or a whole folder from
**Documents**, a PDF from **Audiobooks → Upload a PDF** (and a voice recording from **Add a voice**),
or audio and markdown from the **Attach** button in chat. An upload lands on the backend as a
path, which the Transcribe box, the Make a Google Doc button or the Audiobooks panel then uses — or,
from chat, the assistant is told about it with your next message.

**Audiobooks** (`src/components/Audiobooks.tsx`) is the interface of the `audiobook` tool, which has
none of its own. Reading a book, rendering it and cloning a voice are background jobs in the tool;
the panel polls `audiobook__job_status`, so it can be closed and reopened mid-render. Finished audio
is played and downloaded through the backend's `/api/files`, which wants the token in a header like
every other call — so `fetchMedia` (`src/api.ts`) fetches the file and hands the player a blob,
rather than pointing an `<audio>` tag at a URL with the token in it.

**The access token arrives by itself.** Given `ASSISTANT_TOKEN` in its environment (which
`../start` sets, fresh each launch, for both programs), this app's server writes it into the
page as it serves it — at serve time only, never into `dist/`, and only to a request whose
`Host` is localhost. When the backend refuses a token after a restart, the app re-fetches its
own page for the new one and carries on. Only when it has no token to be had — the two halves
started separately with nothing shared — does it show a Connect screen and ask for the token
the backend prints.

**Where the backend is is decided in the browser, at run time** (`apiUrl()` in `src/api.ts`), so one
build serves every host: `VITE_API_URL` if a build was made for one place; on localhost,
`http://127.0.0.1:8750`; on any other name, the *same host* the page came from at the port the web
server was told (`ASSISTANT_REMOTE_API_PORT`, written into the page). The backend allows calls only
from the origins it is told (`ASSISTANT_ORIGINS`; by default this app's two, ports 8751 and 5173).

The server's own settings, all environment variables, read when it starts:

| Variable | What it does |
|---|---|
| `WEB_HOST` | Address to bind. `127.0.0.1` unless it runs in a container's own network. |
| `ASSISTANT_HOSTS` | Names, besides localhost, that may open the page. Exact names, shared with the backend. |
| `ASSISTANT_REMOTE_API_PORT` | The backend's port when the page was opened by a name other than localhost. |
| `ASSISTANT_TOKEN` | The token handed to the page at serve time (never at build time). |
| `WEB_INJECT_TOKEN` | `0` leaves the token out of the page: for when signing in replaces it. |
