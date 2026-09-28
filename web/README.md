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

**The first time, and after each backend restart**, the app asks for the backend's access
token. Copy it from the terminal where the backend started (the line `access token: …`). The
browser remembers it until the backend restarts with a new one. To skip that during
development, run the backend with a fixed `ASSISTANT_TOKEN` and put the same value in
`web/.env` as `VITE_ASSISTANT_TOKEN`.

The backend is found at `VITE_API_URL` (default `http://127.0.0.1:8750`), and it allows calls
only from this app's two origins, ports 8751 and 5173.
