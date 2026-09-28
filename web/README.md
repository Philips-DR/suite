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
**Documents**, or either from the **Attach** button in chat. An upload lands on the backend as a
path, which the Transcribe box or the Make a Google Doc button then uses — or, from chat, the
assistant is told about it with your next message.

**The access token arrives by itself.** Given `ASSISTANT_TOKEN` in its environment (which
`../start` sets, fresh each launch, for both programs), this app's server writes it into the
page as it serves it — at serve time only, never into `dist/`, and only to a request whose
`Host` is localhost. When the backend refuses a token after a restart, the app re-fetches its
own page for the new one and carries on. Only when it has no token to be had — the two halves
started separately with nothing shared — does it show a Connect screen and ask for the token
the backend prints.

The backend is found at `VITE_API_URL` (default `http://127.0.0.1:8750`), and it allows calls
only from this app's two origins, ports 8751 and 5173.
