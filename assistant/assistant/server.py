"""The assistant as a long-running server: one process, the tools held open, a browser in front.

Chat and buttons are two views of ONE system, not two apps. Every button action that changes
something is noted and handed to the model with your next message, so "stop the recording"
pressed in buttons mode and "write it up" typed in chat mode refer to the same recording.
Every chat action streams to the browser as events, so a transcription the model started
shows up in the buttons view with a live status. One state, one event stream, one gate.

Security, because this process can send email as you:

  * it binds to 127.0.0.1 only;
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
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from assistant.approval import WEB_PREVIEW_LIMIT, needs_approval, sanitise
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
# Where the web app is served from: its own server (8751) and Vite's development server.
# Only these origins may read responses; the token is still required on every call.
DEFAULT_ORIGINS = ("http://127.0.0.1:8751", "http://localhost:8751",
                   "http://127.0.0.1:5173", "http://localhost:5173")
NOTE_LIMIT = 400


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
    on_ready: Callable[[], None] | None = None,
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

    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
        if host not in LOCAL_HOSTS:
            return JSONResponse({"error": "forbidden host"}, status_code=403)
        if request.url.path.startswith("/api/"):
            supplied = request.headers.get("x-assistant-token") or ""
            # EventSource cannot send headers, so the event stream alone takes the token as
            # a query parameter. Everywhere else it stays out of URLs, and out of logs.
            if not supplied and request.url.path == "/api/events":
                supplied = request.query_params.get("token", "")
            if not secrets.compare_digest(supplied, token):
                return JSONResponse({"error": "missing or wrong token"}, status_code=401)
        return await call_next(request)

    # Added after the guard, so it runs outside it: a browser's preflight carries no token
    # and must be answered here, and the guard's own 401 needs these headers too -- without
    # them the web app sees "network error" and cannot tell a stale token from a dead server.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(origins),
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["content-type", "x-assistant-token"],
        allow_credentials=False,  # nothing here uses cookies; the token travels in a header
    )

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
    fixed = bool(os.environ.get("ASSISTANT_TOKEN"))
    holder: dict[str, FastAPI] = {}

    def announce() -> None:
        # Printed for the case where the web app runs without being handed the token (the two
        # started separately); ../start gives both the same one and nobody needs this line.
        # flush: when stdout is a file or a pipe rather than a terminal, Python holds these
        # back, and the one line a person needs to connect never appears in the log.
        print(f"assistant API on http://127.0.0.1:{args.port}/  (localhost only)", flush=True)
        print(f"access token: {holder['app'].state.token}", flush=True)
        if not fixed:
            print("  (new on every launch; set ASSISTANT_TOKEN in .env to keep one across restarts)",
                  flush=True)

    app = create_app(Path(args.tools), Path(args.memory), Path(args.audit), uploads_path=uploads,
                     provider=args.provider, model=args.model,
                     token=os.environ.get("ASSISTANT_TOKEN") or None,
                     origins=origins or DEFAULT_ORIGINS, on_ready=announce)
    holder["app"] = app
    # Never 0.0.0.0. This process can send email as you.
    #
    # timeout_graceful_shutdown is not optional. uvicorn waits for open connections to drain
    # before stopping, and the event stream never drains on its own -- so any browser tab left
    # open blocked shutdown forever, and the three tool processes with it. Found by trying to
    # restart the server with a stream still connected.
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning",
                timeout_graceful_shutdown=3)


if __name__ == "__main__":
    main()
