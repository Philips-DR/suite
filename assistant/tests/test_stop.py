"""Stopping a reply part-way (Chat's Stop button).

A fake model and a fake registry, no network: the model's answer can be made to wait, so a stop can land while it
is thinking, while a tool runs, or while an approval waits. What must hold every time: nothing already running is
cut off, nothing not yet started starts, and the conversation is left whole for the next message.
"""

import asyncio
import json
import threading
from types import SimpleNamespace

from assistant import session
from assistant.audit import FileAuditStore
from assistant.session import STOPPED_REPLY, STOPPED_TOOL, run_turn
from assistant.tools import RemoteTool, ToolRegistry
from tests.test_server import AUTH, app_for, with_client

READ = RemoteTool(server="t", name="look", qualified_name="t__look", description="", input_schema={}, read_only=True)
WRITE = RemoteTool(server="t", name="change", qualified_name="t__change", description="", input_schema={}, read_only=False,
                   title="Change a thing")


def text(words):
    return SimpleNamespace(type="text", text=words)


def tool_use(block_id, tool):
    return SimpleNamespace(type="tool_use", id=block_id, name=tool.qualified_name, input={})


class FakeModel:
    """Answers in order; an answer given as a threading.Event waits for it first (a slow model)."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = 0
        self.messages = SimpleNamespace(create=self.create)

    def create(self, **_):
        self.calls += 1
        answer = self.answers.pop(0)
        if isinstance(answer, threading.Event):
            answer.wait(5)
            answer = self.answers.pop(0)
        return answer


class FakeTools:
    def __init__(self, during_call=None):
        self.ran = []
        self.during_call = during_call

    def find(self, name):
        return {READ.qualified_name: READ, WRITE.qualified_name: WRITE}.get(name)

    def anthropic_tools(self):
        return []

    async def preview_of(self, tool, arguments):
        return None

    async def call(self, tool, arguments):
        self.ran.append(tool.name)
        if self.during_call:
            self.during_call()
        return SimpleNamespace(text=f"{tool.name} done", is_error=False)


def answer(*content, stop_reason="end_turn"):
    return SimpleNamespace(content=list(content), stop_reason=stop_reason)


def roles_alternate(messages):
    return all(a["role"] != b["role"] for a, b in zip(messages, messages[1:]))


def turn(monkeypatch, tmp_path, model, tools, stop, gate=None, before=None):
    monkeypatch.setattr(session, "build_client", lambda config: model)
    messages = [{"role": "user", "content": "hello"}]
    events = []

    async def emit(event):
        events.append(event)

    async def allow(request):
        return True

    async def go():
        if before:
            asyncio.get_running_loop().call_later(0.05, before)
        return await run_turn(tools, SimpleNamespace(resolved_model="m"), messages, FileAuditStore(tmp_path / "audit.jsonl"),
                              gate=gate or allow, emit=emit, stop=stop)

    reply = asyncio.run(go())
    return reply, messages, events


def test_a_stop_while_the_model_thinks_throws_its_answer_away(monkeypatch, tmp_path):
    # The model answers only well after Stop: the turn must end without waiting for it, and never use it.
    slow = threading.Event()
    threading.Timer(0.5, slow.set).start()
    model = FakeModel(slow, answer(tool_use("b1", WRITE), stop_reason="tool_use"))
    tools = FakeTools()
    stop = asyncio.Event()
    reply, messages, events = turn(monkeypatch, tmp_path, model, tools, stop, before=stop.set)
    assert reply == STOPPED_REPLY
    assert tools.ran == []  # the late answer asked for a tool; it never ran
    assert messages == [{"role": "user", "content": "hello"},
                        {"role": "assistant", "content": [{"type": "text", "text": STOPPED_REPLY}]}]
    assert events[-1]["type"] == "turn_stopped"


def test_a_tool_already_running_finishes_and_the_next_one_never_starts(monkeypatch, tmp_path):
    stop = asyncio.Event()
    model = FakeModel(answer(tool_use("b1", WRITE), tool_use("b2", WRITE), stop_reason="tool_use"), answer(text("never asked")))
    tools = FakeTools(during_call=stop.set)  # Stop pressed while the first tool runs
    reply, messages, events = turn(monkeypatch, tmp_path, model, tools, stop)
    assert tools.ran == ["change"]
    assert model.calls == 1
    results = messages[-2]["content"]
    assert [r["content"] for r in results] == ["change done", STOPPED_TOOL]
    assert results[1]["is_error"] is True
    assert reply == STOPPED_REPLY and roles_alternate(messages)
    # the tool that ran is in the audit log, as any other
    rows = [json.loads(line) for line in (tmp_path / "audit.jsonl").read_text().splitlines()]
    assert [(r["tool"], r["outcome"]) for r in rows] == [("t__change", "ok")]


def test_a_turn_nobody_stops_runs_as_it_always_did(monkeypatch, tmp_path):
    model = FakeModel(answer(tool_use("b1", READ), stop_reason="tool_use"), answer(text("All quiet.")))
    tools = FakeTools()
    reply, messages, events = turn(monkeypatch, tmp_path, model, tools, asyncio.Event())
    assert reply == "All quiet."
    assert tools.ran == ["look"]
    assert events[-1]["type"] == "turn_done"


def test_stop_declines_an_approval_that_is_waiting_and_ends_the_turn(monkeypatch, tmp_path):
    app = app_for(tmp_path)
    model = FakeModel(answer(tool_use("b1", WRITE), tool_use("b2", WRITE), stop_reason="tool_use"), answer(text("never asked")))
    monkeypatch.setattr(session, "build_client", lambda config: model)

    async def body(client):
        hub = app.state.hub
        hub.registry = FakeTools()
        await client.post("/api/chat", headers=AUTH, json={"message": "change it"})
        for _ in range(100):  # until the first change waits for approval
            if hub.pending:
                break
            await asyncio.sleep(0.01)
        stopped = await client.post("/api/chat/stop", headers=AUTH)
        await asyncio.wait_for(hub.turn, 5)
        again = await client.post("/api/chat/stop", headers=AUTH)
        return stopped, again, hub

    stopped, again, hub = asyncio.run(with_client(app, body))
    assert stopped.status_code == 200
    assert again.status_code == 409  # nothing left to stop
    assert hub.registry.ran == []  # declined, and the second never asked
    results = hub.messages[-2]["content"]
    assert results[0]["content"].startswith("The user declined") and results[1]["content"] == STOPPED_TOOL
    assert hub.messages[-1]["content"][0]["text"] == STOPPED_REPLY and roles_alternate(hub.messages)
    assert [e["type"] for e in hub.history][-1] == "turn_stopped"
    # the approval the page showed was called what the tool calls itself
    asked = next(e for e in hub.history if e["type"] == "approval_needed")
    assert asked["title"] == "Change a thing"


def test_clearing_the_chat_takes_the_stopped_line_with_it(tmp_path):
    app = app_for(tmp_path)

    async def body(client):
        hub = app.state.hub
        await hub.emit({"type": "user_message", "text": "hi"})
        await hub.emit({"type": "turn_stopped"})
        await client.post("/api/chat/clear", headers=AUTH)
        return [e["type"] for e in hub.history]

    assert asyncio.run(with_client(app, body)) == ["chat_cleared"]


def test_stopping_needs_the_token_and_something_to_stop(tmp_path):
    async def body(client):
        return (await client.post("/api/chat/stop")).status_code, (await client.post("/api/chat/stop", headers=AUTH)).status_code
    assert asyncio.run(with_client(app_for(tmp_path), body)) == (401, 409)


def test_a_tool_keeps_the_title_it_gives_a_person():
    """The approval card and Chat's steps say "Write a new draft", not "draft new": the title a tool gives itself,
    or the one in its annotations, or nothing (the page then words the name itself)."""
    from mcp.types import ListToolsResult, Tool, ToolAnnotations

    listed = ListToolsResult(tools=[
        Tool(name="draft_new", title="Write a new draft", input_schema={"type": "object"}),
        Tool(name="trash", input_schema={"type": "object"}, annotations=ToolAnnotations(title="Move to the Trash")),
        Tool(name="status", input_schema={"type": "object"}),
    ])

    class Session:
        async def list_tools(self):
            return listed

    tools = asyncio.run(ToolRegistry._describe(SimpleNamespace(safe_name="t"), Session()))
    assert [t.title for t in tools] == ["Write a new draft", "Move to the Trash", ""]


def test_the_interface_is_given_each_tool_s_title(tmp_path):
    async def body(client):
        return (await client.get("/api/tools", headers=AUTH)).json()
    assert all("title" in tool for tool in asyncio.run(with_client(app_for(tmp_path), body)))
