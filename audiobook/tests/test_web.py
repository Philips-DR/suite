"""Web API tests that need no models: they use the Docling cache for the test paper."""

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from audiobook.extract import is_extracted
from audiobook.web.app import create_app

PAPER = Path("/home/philip/Documents/books/2609.09153v1.pdf")
pytestmark = pytest.mark.skipif(not (PAPER.exists() and is_extracted(PAPER)), reason="test paper not analysed locally")


@pytest.fixture
def client(tmp_path):
    shutil.copy(PAPER, tmp_path / "paper.pdf")
    return TestClient(create_app(tmp_path))


def test_library_and_book(client):
    books = client.get("/api/books").json()
    assert books == [{"id": "paper", "title": "Procedural Graphs: Self-Evolving Execution Structures for LLM Agents",
                      "author": "Yuxing Lu; Yicheng Chen; Shanchan Wu; Sercan Ö. Arık", "analysed": True}]
    book = client.get("/api/books/paper").json()
    assert [c["label"] for c in book["chapters"]][:3] == ["Opening", "1. Introduction", "2. Related Work"]
    assert book["chapters"][1]["segments"][0]["kind"] == "paragraph"


def test_corrections_round_trip(client, tmp_path):
    assert client.put("/api/books/paper/corrections", json={"text": "Procedural Graph => PG"}).status_code == 200
    assert client.get("/api/books/paper/corrections").json() == {"text": "Procedural Graph => PG"}
    intro = client.get("/api/books/paper").json()["chapters"][1]["segments"]
    assert not any("Procedural Graph " in s["text"] for s in intro)


def test_rejects_bad_input(client):
    assert client.get("/api/books/../etc").status_code == 404
    assert client.get("/api/books/nope").status_code == 404
    assert client.get("/files/x/../../.env").status_code == 404
    assert client.post("/api/books/paper/render", json={"voice": "abigail", "speed": 5}).status_code == 400
    assert client.post("/api/voices", data={"name": "x"}, files={"clip": ("a.wav", b"RIFF")}).status_code == 400  # no consent
