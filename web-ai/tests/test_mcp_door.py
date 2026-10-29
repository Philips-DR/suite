"""Tests for the MCP front door, driven through list_tools() and call_tool(): the path a real session takes once
the transport is stripped away. Servers are on this machine's loopback; nothing reaches the internet."""

import asyncio
import json

from mcp import Client

from fakesite import Site, fetcher, html
from webai.mcp_server import create_web_ai_server

PAGE = "<html><head><title>Analyst</title></head><body><h1>Analyst</h1><a href='/next'>Next</a></body></html>"


def call(server, name, **arguments):
    """Through a real client session over memory streams, so an error is the error result a session would see
    (called directly, the server raises instead, and `is_error` would never be tested)."""
    async def session():
        async with Client(server) as client:
            return await client.call_tool(name, arguments)
    return asyncio.run(session())


def data(result) -> dict:
    return json.loads("".join(b.text for b in result.content if b.type == "text"))


def test_the_door_advertises_exactly_three_tools_that_read_the_open_web():
    tools = asyncio.run(create_web_ai_server().list_tools())
    assert sorted(t.name for t in tools) == ["check_link", "github_visibility", "read_page"]
    assert all(t.annotations.read_only_hint is True for t in tools)   # so the assistant's gate does not stop them
    assert all(t.annotations.open_world_hint is True for t in tools)  # and they say they reach outside


def test_the_descriptions_carry_the_procedure_the_assistant_must_follow():
    by_name = {t.name: t.description for t in asyncio.run(create_web_ai_server().list_tools())}
    read = by_name["read_page"]
    assert "untrusted" in read and "apply_ai__requirements" in read and "links" in read
    assert "PDF" in read and "paste" in read and "private network" in read
    assert "HEAD" in by_name["check_link"]
    assert "stranger" in by_name["github_visibility"] and "does not exist" in by_name["github_visibility"]


def test_read_page_through_the_door():
    with Site({"/jobs": html(PAGE)}) as site:
        result = call(create_web_ai_server(fetcher()), "read_page", url=site.url("/jobs"))
    out = data(result)
    assert not result.is_error
    assert (out["title"], out["method"]) == ("Analyst", "http") and out["text"] == "Analyst\nNext"   # the link's words are part of the page
    assert out["links"] == [{"text": "Next", "url": site.url("/next")}]


def test_a_failed_fetch_is_an_error_result_so_the_audit_log_records_it_as_a_failure():
    """apply-ai returns its refusals as data; this tool must not, or a refused address is logged as `ok`."""
    with Site({"/": html("inside")}) as site:
        result = call(create_web_ai_server(), "read_page", url=site.url())      # the real, default fetcher
    assert result.is_error is True
    assert "not a public internet address" in result.content[0].text
    assert site.requests == []


def test_a_refused_scheme_is_an_error_result_too():
    result = call(create_web_ai_server(), "check_link", url="file:///etc/passwd")
    assert result.is_error is True and "Only http and https" in result.content[0].text


def test_a_tool_call_writes_nothing_to_stdout(capfd):
    """On stdio, stdout IS the protocol: one stray line corrupts the session."""
    with Site({"/": html(PAGE)}) as site:
        call(create_web_ai_server(fetcher()), "read_page", url=site.url())
        call(create_web_ai_server(fetcher()), "check_link", url=site.url())
        call(create_web_ai_server(), "read_page", url=site.url())     # a refusal too
    assert capfd.readouterr().out == ""
