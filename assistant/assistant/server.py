"""The assistant as a long-running server: one process, the tools held open, a browser in front.

Chat and buttons are two views of ONE system, not two apps. Every button action that changes
something is noted and handed to the model with your next message, so "stop the recording"
pressed in buttons mode and "write it up" typed in chat mode refer to the same recording.
Every chat action streams to the browser as events, so a transcription the model started
shows up in the buttons view with a live status. One state, one event stream, one gate.

Security, because this process can send email as you:

  * it binds to 127.0.0.1 unless told otherwise (ASSISTANT_HOST: a container's private network);
  * every /api request must carry a random token issued at launch and injected into the
    page -- a site in another tab can make your browser POST to localhost, but it cannot
    read the page to learn the token;
  * requests whose Host is not localhost are refused, which closes DNS rebinding.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from assistant.approval import WEB_PREVIEW_LIMIT, needs_approval, sanitise
from assistant.auth import (
    AuthError, SessionStore, clear_cookie, exchange_code, fetch_userinfo,
    google_login_url, parse_allowed_emails, pkce_pair, set_cookie,
)
from assistant.config import load_tool_servers, model_config_from_environment
from assistant.session import ApprovalRequest, allow_gate, execute, run_turn
from assistant import uploads as up
from assistant.documents import document_tools
from assistant.setup import current_lexicon, prepare
from assistant.status import model_status, network_status, tools_status
from assistant.tools import RemoteTool, ToolRegistry
from assistant.watchers import watch, watch_login

ROOT = Path(__file__).resolve().parent.parent
HISTORY_LIMIT = 1000
KEEPALIVE_SECONDS = 15
LOCAL_HOSTS = {"127.0.0.1", "localhost"}
LOOPBACK_BINDS = {"127.0.0.1", "::1", "localhost"}


def parse_hosts(value: str | None) -> frozenset[str]:
    """Names the API may be reached by, beyond localhost: ASSISTANT_HOSTS, comma separated. Exact
    names only, never patterns -- the Host check is what stops a hostile page pointing its own name at
    this machine, and a pattern is a bigger door than a name."""
    return frozenset(part.strip().lower() for part in (value or "").replace(" ", ",").split(",") if part.strip())
# Where the web app is served from: its own server (8751) and Vite's development server.
# Only these origins may read responses; the token is still required on every call.
DEFAULT_ORIGINS = ("http://127.0.0.1:8751", "http://localhost:8751",
                   "http://127.0.0.1:5173", "http://localhost:5173")
NOTE_LIMIT = 400
# Audio a tool may offer for playing and download. A tool's folder is not enough on its own:
# only these kinds of file are ever sent.
MEDIA_TYPES = {".mp3": "audio/mpeg", ".m4b": "audio/mp4", ".m4a": "audio/mp4", ".wav": "audio/wav",
               ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg"}


def approval_view(request: ApprovalRequest) -> dict[str, Any]:
    return {
        "id": request.id,
        "tool": request.tool.qualified_name,
        "server": request.tool.server,
        "name": request.tool.name,
        "arguments": request.arguments,
        # Untrusted content (an email body, a transcript) on its way to a screen. The
        # browser renders it as text, never HTML; this also caps its length.
        "preview": sanitise(request.preview, WEB_PREVIEW_LIMIT) if request.preview else None,
        "preview_expected": request.preview_expected,
    }


def parsed(output: str) -> Any:
    try:
        return json.loads(output)
    except (json.JSONDecodeError, TypeError):
        return output


class Hub:
    """Everything the browser and the model share."""

    def __init__(self, registry: ToolRegistry, config: Any, context: str, audit_path: Path,
                 refresh_context: Callable[[], str] | None = None) -> None:
        self.registry = registry
        self.config = config
        self.context = context
        # A server runs for days. Memory written mid-session -- a fact remembered, a spelling
        # corrected -- must reach the model on the next turn, not after a restart.
        self.refresh_context = refresh_context
        self.audit_path = audit_path
        self.messages: list[dict[str, Any]] = []
        self.notes: list[str] = []
        self.turn: asyncio.Task | None = None
        self.pending: dict[str, tuple[ApprovalRequest, asyncio.Future]] = {}
        self.subscribers: set[asyncio.Queue] = set()
        self.history: deque[dict[str, Any]] = deque(maxlen=HISTORY_LIMIT)
        self.seq = 0

    @property
    def busy(self) -> bool:
        return self.turn is not None and not self.turn.done()

    async def emit(self, event: dict[str, Any]) -> None:
        self.seq += 1
        stamped = {**event, "seq": self.seq, "at": time.time()}
        self.history.append(stamped)
        for queue in list(self.subscribers):
            queue.put_nowait(stamped)

    async def web_gate(self, request: ApprovalRequest) -> bool:
        """Suspend the turn until a person answers in the browser."""
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[request.id] = (request, future)
        await self.emit({"type": "approval_needed", **approval_view(request)})
        try:
            return await future
        finally:
            self.pending.pop(request.id, None)

    def compose(self, message: str) -> str:
        """The user's message, with anything they did through buttons since the last one.

        Notes are held until a turn boundary rather than appended as they happen: a note
        landing mid-turn would sit between a tool call and its result, and the model's API
        rejects a conversation with that shape.
        """
        if not self.notes:
            return message
        done = "\n".join(f"- {note}" for note in self.notes)
        self.notes.clear()
        return f"[Since your last message, you did this in the interface:\n{done}]\n\n{message}"

    async def run(self, message: str) -> None:
        checkpoint = len(self.messages)
        held = list(self.notes)
        await self.emit({"type": "user_message", "text": message})
        if self.refresh_context is not None:
            self.context = self.refresh_context()
        self.messages.append({"role": "user", "content": self.compose(message)})
        try:
            await run_turn(self.registry, self.config, self.messages, self.audit_path,
                           context=self.context, gate=self.web_gate, emit=self.emit)
        except Exception as error:
            # A failed turn can leave a tool call without its result, which would poison
            # every later turn. Roll the conversation back to before it, and keep the notes.
            del self.messages[checkpoint:]
            self.notes = held + self.notes
            await self.emit({"type": "turn_error", "error": str(error)[:500]})

    def note_text(self, text: str) -> None:
        """Something that happened outside any tool call -- an upload -- told to the model the
        same way a button press is, with the next message."""
        self.notes.append(text[:NOTE_LIMIT])

    def note(self, tool: RemoteTool, arguments: dict[str, Any], outcome: str, output: str) -> None:
        compact = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
        self.notes.append(
            f"{tool.server}.{tool.name}({compact}) -> {outcome}: {output[:NOTE_LIMIT]}"
        )


class ChatRequest(BaseModel):
    message: str


class ApprovalAnswer(BaseModel):
    approve: bool


class ActionRequest(BaseModel):
    tool: str
    arguments: dict[str, Any] = {}
    confirmed: bool = False


def create_app(
    tools_path: Path,
    memory_path: Path,
    audit_path: Path,
    provider: str | None = None,
    model: str | None = None,
    token: str | None = None,
    registry_factory: Callable[[list[Any]], ToolRegistry] | None = None,
    watch_jobs: bool = True,
    uploads_path: Path | None = None,
    origins: tuple[str, ...] = DEFAULT_ORIGINS,
    hosts: frozenset[str] = frozenset(),
    on_ready: Callable[[], None] | None = None,
    google_client_id: str | None = None,
    google_client_secret: str | None = None,
    google_redirect_uri: str | None = None,
    allowed_emails: frozenset[str] = frozenset(),
) -> FastAPI:
    uploads_root = uploads_path or ROOT / "uploads"
    token = token or secrets.token_urlsafe(24)
    holder: dict[str, Hub] = {}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        config = model_config_from_environment(provider, model)
        _store, local_tools, context = prepare(memory_path)
        local_tools = [*local_tools, *document_tools(uploads_root)]
        registry = (registry_factory(local_tools) if registry_factory
                    else ToolRegistry(load_tool_servers(tools_path), local=local_tools))
        # Held open for the life of the server: the tools stay running instead of being
        # relaunched for every request.
        await registry.__aenter__()
        holder["hub"] = Hub(registry, config, context, audit_path,
                            refresh_context=lambda: prepare(memory_path)[2])
        app.state.hub = holder["hub"]
        # Tells the browser when a long job finishes, so nobody has to keep asking.
        watchers = [
            asyncio.create_task(watch(registry, holder["hub"].emit)),
            asyncio.create_task(watch_login(config, holder["hub"].emit)),
        ] if watch_jobs else []
        # Only now -- tools started, hub up -- is the server really accepting calls. Announcing
        # earlier sent people (and a browser tab) to a port that refused the connection.
        if on_ready is not None:
            on_ready()
        try:
            yield
        finally:
            for task in watchers:
                task.cancel()
            await registry.__aexit__(None, None, None)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.token = token

    def hub() -> Hub:
        return holder["hub"]

    allowed_hosts = LOCAL_HOSTS | hosts
    sessions = SessionStore() if google_client_id and google_client_secret else None

    def authenticate(request: Request) -> bool:
        """Is this request from someone who may use the API? The one place that decides.

        Two ways in: the launch token (header or, for EventSource, query param) and a Google
        sign-in session cookie. Either one is enough."""
        supplied = request.headers.get("x-assistant-token") or ""
        if not supplied and request.url.path == "/api/events":
            supplied = request.query_params.get("token", "")
        if supplied and secrets.compare_digest(supplied, token):
            return True
        if sessions is not None:
            sid = request.cookies.get("session", "")
            if sid and sessions.get(sid) is not None:
                return True
        return False

    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in allowed_hosts:
            return JSONResponse({"error": "forbidden host"}, status_code=403)
        path = request.url.path
        if path.startswith("/auth/") or path == "/api/me":
            return await call_next(request)
        if path.startswith("/api/") and not authenticate(request):
            return JSONResponse({"error": "missing or wrong token"}, status_code=401)
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(origins),
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["content-type", "x-assistant-token", "ngrok-skip-browser-warning"],
        allow_credentials=True,
    )

    # -----------------------------------------------------------------------
    # Google sign-in (when configured)
    # -----------------------------------------------------------------------

    if sessions is not None and google_client_id and google_client_secret and google_redirect_uri:
        @app.get("/auth/login")
        async def auth_login(request: Request):
            redirect = request.query_params.get("redirect", "")
            if redirect and not any(redirect.rstrip("/") == o.rstrip("/") for o in origins):
                return JSONResponse({"error": "invalid redirect"}, status_code=400)
            verifier, challenge = pkce_pair()
            state = secrets.token_urlsafe(24)
            sessions.save_pending(state, verifier, redirect)
            return RedirectResponse(
                google_login_url(google_client_id, google_redirect_uri, state, challenge),
                status_code=302,
            )

        @app.get("/auth/callback")
        @app.get("/auth/callback/")
        async def auth_callback(request: Request):
            error = request.query_params.get("error")
            state = request.query_params.get("state", "")
            pending = sessions.pop_pending(state) if state else None

            if error:
                target = pending[1] if pending else "/"
                return RedirectResponse(target)

            code = request.query_params.get("code")
            if not code or not pending:
                return JSONResponse({"error": "missing code or expired state"}, status_code=400)
            verifier, redirect = pending

            try:
                tokens = await exchange_code(
                    google_client_id, google_client_secret, google_redirect_uri, code, verifier)
                access_token = tokens.get("access_token")
                if not access_token:
                    raise AuthError("no access token in response")
                userinfo = await fetch_userinfo(access_token)
            except AuthError:
                return JSONResponse({"error": "sign-in failed"}, status_code=502)

            email = (userinfo.get("email") or "").lower()
            if not userinfo.get("email_verified"):
                return JSONResponse({"error": "email not verified by Google"}, status_code=403)
            if email not in allowed_emails:
                return JSONResponse({"error": "this account is not allowed"}, status_code=403)

            sid = sessions.create(email)
            secure = request.url.scheme == "https"
            target = redirect or "/"
            if "127.0.0.1" in target:
                target = target.replace("127.0.0.1", "localhost")
            response = RedirectResponse(target, status_code=302)
            response.headers["set-cookie"] = set_cookie(sid, secure)
            return response

        @app.post("/auth/logout")
        async def auth_logout(request: Request):
            sid = request.cookies.get("session", "")
            if sid:
                sessions.delete(sid)
            secure = request.url.scheme == "https"
            response = JSONResponse({"ok": True})
            response.headers["set-cookie"] = clear_cookie(secure)
            return response

    @app.get("/api/me")
    async def me(request: Request):
        email = None
        if sessions is not None:
            sid = request.cookies.get("session", "")
            session = sessions.get(sid) if sid else None
            if session:
                email = session.email
        return {"email": email, "google_auth": sessions is not None}

    @app.get("/api/tools")
    async def tools() -> list[dict[str, Any]]:
        return [
            {
                "qualified_name": t.qualified_name, "server": t.server, "name": t.name,
                "description": t.description, "read_only": t.read_only,
                "has_preview": t.preview is not None, "input_schema": t.input_schema,
            }
            for t in hub().registry.tools
        ]

    @app.get("/api/state")
    async def state() -> dict[str, Any]:
        h = hub()
        return {
            "busy": h.busy,
            "pending": [approval_view(r) for r, _f in h.pending.values()],
            "history": list(h.history),
            "notes": list(h.notes),
            "model": h.config.resolved_model,
        }

    @app.post("/api/chat")
    async def chat(body: ChatRequest) -> dict[str, Any]:
        h = hub()
        if not body.message.strip():
            raise HTTPException(400, "empty message")
        if h.busy:
            raise HTTPException(409, "still working on the last message")
        h.turn = asyncio.create_task(h.run(body.message.strip()))
        return {"accepted": True}

    @app.post("/api/approvals/{approval_id}")
    async def answer(approval_id: str, body: ApprovalAnswer) -> dict[str, Any]:
        h = hub()
        entry = h.pending.get(approval_id)
        if entry is None:
            raise HTTPException(404, "no such pending approval")
        request, future = entry
        if not future.done():
            future.set_result(body.approve)
        await h.emit({"type": "approval_resolved", "id": approval_id,
                      "tool": request.tool.qualified_name, "approved": body.approve})
        return {"approved": body.approve}

    @app.post("/api/actions")
    async def action(body: ActionRequest) -> dict[str, Any]:
        """A button press: you chose the tool, so no model is involved.

        The click is the approval -- except where the tool declares a preview of its
        effect, as sending an email does. There the first press returns the preview and
        only a confirmed second press acts, the same rule the chat gate applies.
        """
        h = hub()
        tool = h.registry.find(body.tool)
        if tool is None:
            raise HTTPException(404, f"no tool {body.tool}")

        if needs_approval(tool) and tool.preview is not None and not body.confirmed:
            preview = await h.registry.preview_of(tool, body.arguments)
            return {"needs_confirmation": True,
                    "preview": sanitise(preview, WEB_PREVIEW_LIMIT) if preview else None,
                    "preview_expected": True}

        arguments = dict(body.arguments)
        if "lexicon" in (tool.input_schema.get("properties") or {}) and "lexicon" not in arguments:
            lexicon = current_lexicon(memory_path)
            if lexicon is not None:
                arguments["lexicon"] = str(lexicon)

        output, outcome = await execute(h.registry, tool, arguments, h.audit_path,
                                        allow_gate, h.emit, origin="button")
        # Only actions that changed something become notes. A status poll every few seconds
        # would bury the model's context in noise.
        if not tool.read_only:
            h.note(tool, arguments, outcome, output)
        return {"outcome": outcome, "output": parsed(output)}

    @app.get("/api/events")
    async def events(request: Request) -> StreamingResponse:
        h = hub()
        queue: asyncio.Queue = asyncio.Queue()
        h.subscribers.add(queue)

        async def stream():
            # Sent at once, before any event exists. A browser only fires EventSource.onopen
            # when the first bytes arrive, so without this every page load reported
            # "reconnecting" -- and kept the message box disabled -- for up to 15 seconds.
            yield ": connected\n\n"
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                        yield f"data: {json.dumps(event, default=str)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                h.subscribers.discard(queue)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @app.get("/api/status")
    async def status(live: bool = False) -> dict[str, Any]:
        """What Settings shows. Tools are read from what is already known; the network and
        the model login are only checked when asked (live=true), since each costs a round
        trip."""
        h = hub()
        out: dict[str, Any] = {
            "tools": tools_status(h.registry, h.audit_path),
            "model": {"provider": h.config.provider, "model": h.config.resolved_model,
                      "profile": h.config.profile, "region": h.config.region},
            "mail_compose": h.registry.find("mail_ai__send_draft") is not None,
        }
        if live:
            network, model = await asyncio.gather(
                asyncio.to_thread(network_status), asyncio.to_thread(model_status, h.config))
            out["network"], out["model"] = network, model
        return out

    # -----------------------------------------------------------------------
    # Uploads. The body is the file itself, streamed to disk -- a four-hour recording is
    # never held in memory. Each ends in a path, which is all any tool needs.
    # -----------------------------------------------------------------------

    def refuse(error: up.UploadError) -> JSONResponse:
        return JSONResponse({"error": str(error)}, status_code=400)

    @app.get("/api/uploads")
    async def list_uploads() -> dict[str, Any]:
        return up.listing(uploads_root)

    @app.put("/api/uploads/audio")
    async def upload_audio(request: Request, name: str):
        h = hub()
        try:
            target = up.audio_target(uploads_root, name)
            size = await up.receive(target, request.stream(), up.MAX_AUDIO_BYTES)
        except up.UploadError as error:
            return refuse(error)
        h.note_text(f"The user uploaded audio {target.name} ({size} bytes), saved at {target}.")
        await h.emit({"type": "upload", "kind": "audio", "name": target.name, "path": str(target)})
        return {"name": target.name, "path": str(target), "bytes": size}

    @app.put("/api/uploads/book")
    async def upload_book(request: Request, name: str):
        h = hub()
        try:
            target = up.book_target(uploads_root, name)
            size = await up.receive(target, request.stream(), up.MAX_BOOK_BYTES)
        except up.UploadError as error:
            return refuse(error)
        h.note_text(f"The user uploaded a book (PDF) {target.name} ({size} bytes), saved at {target}.")
        await h.emit({"type": "upload", "kind": "book", "name": target.name, "path": str(target)})
        return {"name": target.name, "path": str(target), "bytes": size}

    @app.put("/api/uploads/voice")
    async def upload_voice(request: Request, name: str):
        h = hub()
        try:
            target = up.voice_target(uploads_root, name)
            size = await up.receive(target, request.stream(), up.MAX_VOICE_BYTES)
        except up.UploadError as error:
            return refuse(error)
        h.note_text(f"The user uploaded a recording {target.name} to clone a voice from "
                    f"({size} bytes), saved at {target}.")
        await h.emit({"type": "upload", "kind": "voice", "name": target.name, "path": str(target)})
        return {"name": target.name, "path": str(target), "bytes": size}

    @app.get("/api/files")
    async def media(path: str):
        """Audio a tool made, for the web app to play or download. The token rides in a header
        like everywhere else, so the app fetches this itself rather than pointing an <audio>
        tag at it. Nothing is served unless it is an audio file inside a folder tools.yaml
        declared for some tool; anything else is a plain 404, so the answer says nothing about
        what exists elsewhere."""
        try:
            resolved = Path(path).resolve()  # follows symlinks: the check is on where it really is
        except (ValueError, OSError):  # a NUL byte, an unreadable link loop: still just "not there"
            raise HTTPException(404, "no such file") from None
        roots = [root.resolve() for root in hub().registry.media_roots]
        kind = MEDIA_TYPES.get(resolved.suffix.lower())
        if kind is None or not resolved.is_file() or not any(resolved.is_relative_to(r) for r in roots):
            raise HTTPException(404, "no such file")
        return FileResponse(resolved, media_type=kind, filename=resolved.name)

    @app.post("/api/uploads/docs")
    async def start_docs(body: dict[str, Any]):
        try:
            return {"batch": up.new_batch(uploads_root, str(body.get("name", "")))}
        except up.UploadError as error:
            return refuse(error)

    @app.put("/api/uploads/docs/{batch}")
    async def upload_doc(batch: str, request: Request, name: str):
        try:
            target = up.doc_target(uploads_root, batch, name)
            size = await up.receive(target, request.stream(), up.MAX_DOC_BYTES)
        except up.UploadError as error:
            return refuse(error)
        return {"name": target.name, "bytes": size}

    @app.post("/api/uploads/docs/{batch}/done")
    async def finish_docs(batch: str):
        h = hub()
        batch_dir = (uploads_root / "docs" / batch).resolve()
        if not batch_dir.is_relative_to(uploads_root.resolve()) or not batch_dir.is_dir():
            return refuse(up.UploadError(f"no upload batch {batch!r}"))
        files = sorted(p.name for p in batch_dir.glob("*.md"))
        if not files:
            batch_dir.rmdir()
            return refuse(up.UploadError("none of those files were markdown (.md)"))
        path = up.doc_path(batch_dir)
        h.note_text(f"The user uploaded markdown for a document: {', '.join(files)}, "
                    f"ready to build from {path}.")
        await h.emit({"type": "upload", "kind": "docs", "name": batch_dir.name, "path": str(path)})
        return {"name": batch_dir.name, "path": str(path), "files": files}

    @app.get("/api/history")
    async def audit_history(limit: int = 200) -> list[dict[str, Any]]:
        """The durable record of every tool call, newest first -- the live event stream only
        covers this run; this survives restarts."""
        try:
            lines = audit_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        rows: list[dict[str, Any]] = []
        for line in reversed(lines[-max(1, min(limit, 2000)):]):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # one corrupt line must not hide the rest
        return rows

    @app.get("/")
    async def root() -> dict[str, Any]:
        # The API only. The web app is its own program (suite/web) on its own port, and this
        # server knows nothing about it beyond which origins may call it.
        return {"service": "assistant", "api": "/api"}

    return app


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="The assistant, in a browser.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ASSISTANT_PORT", 8750)))
    parser.add_argument("--host", default=os.environ.get("ASSISTANT_HOST", "127.0.0.1"),
                        help="address to bind; 127.0.0.1 unless this runs in a container's own network")
    parser.add_argument("-t", "--tools", default=str(ROOT / "tools.yaml"))
    parser.add_argument("-m", "--memory", default=os.environ.get("ASSISTANT_MEMORY", str(ROOT / "memory.json")))
    parser.add_argument("-a", "--audit", default=os.environ.get("ASSISTANT_AUDIT", str(ROOT / "audit.jsonl")))
    parser.add_argument("--provider", default=None)
    parser.add_argument("--model", default=None)
    args = parser.parse_args()

    from assistant.cli import quieten_libraries

    quieten_libraries()
    # The token is random per launch unless ASSISTANT_TOKEN fixes it.
    uploads = Path(os.environ["ASSISTANT_UPLOADS"]) if os.environ.get("ASSISTANT_UPLOADS") else None
    origins = tuple(o.strip() for o in os.environ.get("ASSISTANT_ORIGINS", "").split(",") if o.strip())
    hosts = parse_hosts(os.environ.get("ASSISTANT_HOSTS"))
    fixed = bool(os.environ.get("ASSISTANT_TOKEN"))
    holder: dict[str, FastAPI] = {}

    def announce() -> None:
        # Printed for the case where the web app runs without being handed the token (the two
        # started separately); ../start gives both the same one and nobody needs this line.
        # flush: when stdout is a file or a pipe rather than a terminal, Python holds these
        # back, and the one line a person needs to connect never appears in the log.
        if args.host in LOOPBACK_BINDS:
            print(f"assistant API on http://{args.host}:{args.port}/  (localhost only)", flush=True)
        else:
            # Said out loud, because it is the one setting that changes who can knock. Whatever
            # reaches this port still needs the token and a Host from the allowed list.
            print(f"assistant API listening on {args.host}:{args.port} -- NOT localhost-only. Reachable by "
                  f"whatever can reach this port; publish it to 127.0.0.1 or a private network only.", flush=True)
            print(f"  allowed Host names beyond localhost: {', '.join(sorted(hosts)) or '(none)'}", flush=True)
        print(f"access token: {holder['app'].state.token}", flush=True)
        if not fixed:
            print("  (new on every launch; set ASSISTANT_TOKEN in .env to keep one across restarts)",
                  flush=True)

    app = create_app(Path(args.tools), Path(args.memory), Path(args.audit), uploads_path=uploads,
                     provider=args.provider, model=args.model,
                     token=os.environ.get("ASSISTANT_TOKEN") or None,
                     origins=origins or DEFAULT_ORIGINS, hosts=hosts, on_ready=announce,
                     google_client_id=os.environ.get("GOOGLE_CLIENT_ID") or None,
                     google_client_secret=os.environ.get("GOOGLE_CLIENT_SECRET") or None,
                     google_redirect_uri=os.environ.get("GOOGLE_REDIRECT_URI") or None,
                     allowed_emails=parse_allowed_emails(os.environ.get("ASSISTANT_ALLOWED_EMAILS")))
    holder["app"] = app
    # Loopback unless ASSISTANT_HOST says otherwise, and it says otherwise only in the container
    # setup, whose compose file publishes the port to 127.0.0.1 and to a private Tailscale
    # network, never to the world. Never bind 0.0.0.0 on a machine on a network you do not
    # control: this process can send email as you.
    #
    # timeout_graceful_shutdown is not optional. uvicorn waits for open connections to drain
    # before stopping, and the event stream never drains on its own -- so any browser tab left
    # open blocked shutdown forever, and the three tool processes with it. Found by trying to
    # restart the server with a stream still connected.
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning",
                timeout_graceful_shutdown=3)


if __name__ == "__main__":
    main()
