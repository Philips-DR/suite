"""Tests for the MCP front door, driven through list_tools() and call_tool(): the path a real session
takes once the transport is stripped away. No network, no model, nothing outside tmp_path."""

import asyncio
import json

import pytest

from applyai.mcp_server import create_apply_ai_server

CV = "# Name\n\n- Engineered object detection models on drone imagery, reaching 91.8% precision.\n- Python, SQL\n"


@pytest.fixture
def folder(tmp_path):
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "cv.md").write_text(CV)
    (tmp_path / "private.md").write_text("secret\n")
    return tmp_path


@pytest.fixture
def server(folder):
    return create_apply_ai_server([folder / "uploads"])


def call(server, name, **arguments) -> dict:
    result = asyncio.run(server.call_tool(name, arguments))
    return json.loads("".join(b.text for b in result.content if b.type == "text"))


def test_the_door_advertises_exactly_two_tools_and_both_only_read(server):
    tools = asyncio.run(server.list_tools())
    assert sorted(t.name for t in tools) == ["claims", "requirements"]
    # Read-only means the assistant's gate never stops them: there is nothing here for it to gate.
    assert all(t.annotations.read_only_hint is True for t in tools)


def test_the_descriptions_carry_the_procedure_the_assistant_must_follow(server):
    by_name = {t.name: t.description for t in asyncio.run(server.list_tools())}
    assert "FIRST" in by_name["requirements"] and "ONE message" in by_name["requirements"]
    assert "remember" in by_name["requirements"]
    assert "BEFORE write_draft" in by_name["claims"] and "clean: true" in by_name["claims"]
    # An email body claims things too, and a private claim needs the addresses checked (2026-10-30).
    assert "BEFORE draft_new" in by_name["claims"] and "github_visibility" in by_name["claims"]


def test_public_links_reach_the_check_through_the_door(server, folder):
    source = [str(folder / "uploads" / "cv.md")]
    draft = "- My repositories are private."
    assert call(server, "claims", draft=draft, sources=source)["findings"][0]["kind"] == "unchecked"
    out = call(server, "claims", draft=draft, sources=source, public_links=["https://github.com/a/b"])
    assert [f["kind"] for f in out["findings"]] == ["public link"]
    assert call(server, "claims", draft=draft, sources=source, public_links=[])["clean"] is True


def test_requirements_through_the_door(server, folder):
    out = call(server, "requirements", posting="Selection Criteria\n\n● Proficiency in Python\n\n● Master's degree in statistics\n",
               sources=[str(folder / "uploads" / "cv.md")])
    assert out["posting"]["requirements_found"] == 2
    assert {r["status"] for r in out["requirements"]} == {"supported", "gap"}


def test_claims_through_the_door_with_a_confirmed_fact(server, folder):
    source = [str(folder / "uploads" / "cv.md")]
    flagged = call(server, "claims", draft="- Used Stata daily.", sources=source)
    assert flagged["clean"] is False
    settled = call(server, "claims", draft="- Used Stata.", sources=source, facts=["Used Stata at a previous job"])
    assert settled["clean"] is True


def test_a_path_outside_the_uploads_folder_is_refused_in_words(server, folder):
    out = call(server, "claims", draft="- x y z", sources=[str(folder / "private.md")])
    assert out == {"error": "only documents in the uploads folder can be read"}


def test_a_failing_door_reports_an_error_the_model_can_read_not_a_traceback(server, folder):
    out = call(server, "claims", draft="", sources=[str(folder / "uploads" / "cv.md")])
    assert out == {"error": "the draft is empty"}
