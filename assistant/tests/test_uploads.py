"""Tests for uploads. Security first: this endpoint writes to disk whatever a browser sends,
so every name is hostile until checked."""

import asyncio

import pytest

from assistant import uploads as up
from assistant.server import create_app
from assistant.tools import ToolRegistry
from tests.test_server import AUTH, TOKEN, app_for, run, with_client


def client_for(tmp_path, body):
    return run(with_client(app_for(tmp_path, uploads_path=tmp_path / "uploads"), body))


# ---------------------------------------------------------------------------
# Hostile names
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["../escape.m4a", "..", ".hidden.m4a", "a/b.m4a", "a\\b.m4a", "x\x00.m4a", ""])
def test_a_hostile_audio_name_is_refused_or_reduced_to_a_plain_file_name(tmp_path, name):
    root = tmp_path / "uploads"
    try:
        target = up.audio_target(root, name)
    except up.UploadError:
        return
    # Path(name).name keeps only the last component; whatever survives lands in audio/.
    assert target.parent == (root / "audio").resolve()


@pytest.mark.parametrize("name", ["../x.md", "sub/x.md", "..", ".x.md"])
def test_a_markdown_file_cannot_climb_out_of_its_batch_or_into_a_subfolder(tmp_path, name):
    root = tmp_path / "uploads"
    batch = up.new_batch(root, "book")
    with pytest.raises(up.UploadError):
        up.doc_target(root, batch, name)


def test_a_batch_name_cannot_point_outside_the_uploads_folder(tmp_path):
    with pytest.raises(up.UploadError):
        up.doc_target(tmp_path / "uploads", "..", "x.md")


def test_the_upload_endpoints_need_the_token(tmp_path):
    async def body(client):
        return (await client.put("/api/uploads/audio?name=a.m4a", content=b"x")).status_code
    assert client_for(tmp_path, body) == 401


def test_only_audio_is_accepted_for_transcription(tmp_path):
    async def body(client):
        return (await client.put("/api/uploads/audio?name=notes.pdf", headers=AUTH, content=b"x")).json()
    assert "not an audio file" in client_for(tmp_path, body)["error"]


# ---------------------------------------------------------------------------
# Receiving
# ---------------------------------------------------------------------------

def test_an_audio_upload_lands_as_a_path_the_model_is_told_about(tmp_path):
    async def body(client):
        saved = (await client.put("/api/uploads/audio?name=meeting.m4a", headers=AUTH, content=b"audio")).json()
        again = (await client.put("/api/uploads/audio?name=meeting.m4a", headers=AUTH, content=b"more")).json()
        state = (await client.get("/api/state", headers=AUTH)).json()
        listed = (await client.get("/api/uploads", headers=AUTH)).json()
        return saved, again, state, listed

    saved, again, state, listed = client_for(tmp_path, body)
    assert saved["name"] == "meeting.m4a" and saved["bytes"] == 5
    assert again["name"] == "meeting (2).m4a"  # never overwrites an earlier upload
    assert any("meeting.m4a" in n and saved["path"] in n for n in state["notes"])
    assert {a["name"] for a in listed["audio"]} == {"meeting.m4a", "meeting (2).m4a"}


def test_a_half_received_upload_is_never_left_behind(tmp_path):
    target = up.audio_target(tmp_path / "uploads", "long.m4a")

    async def chunks():
        yield b"a" * 10
        raise ConnectionError("browser closed the tab")

    with pytest.raises(ConnectionError):
        asyncio.run(up.receive(target, chunks(), limit=1000))
    assert list((tmp_path / "uploads" / "audio").iterdir()) == []


def test_an_upload_over_the_limit_is_stopped_and_removed(tmp_path):
    target = up.audio_target(tmp_path / "uploads", "huge.m4a")

    async def chunks():
        for _ in range(5):
            yield b"a" * 100

    with pytest.raises(up.UploadError, match="larger than"):
        asyncio.run(up.receive(target, chunks(), limit=250))
    assert list((tmp_path / "uploads" / "audio").iterdir()) == []


def test_one_markdown_file_builds_as_a_file_and_several_as_a_folder(tmp_path):
    """docu-ai gives a lone file one tab and no cover, a folder a tab per file and contents."""
    async def body(client):
        async def upload(name, files):
            batch = (await client.post("/api/uploads/docs", headers=AUTH, json={"name": name})).json()["batch"]
            for f in files:
                await client.put(f"/api/uploads/docs/{batch}?name={f}", headers=AUTH, content=b"# T\n")
            return (await client.post(f"/api/uploads/docs/{batch}/done", headers=AUTH)).json()
        return await upload("cv.md", ["cv.md"]), await upload("handbook", ["01-a.md", "02-b.md"])

    single, folder = client_for(tmp_path, body)
    assert single["path"].endswith("docs/cv/cv.md")
    assert folder["path"].endswith("docs/handbook") and folder["files"] == ["01-a.md", "02-b.md"]


def test_a_batch_with_no_markdown_in_it_is_refused_and_cleared(tmp_path):
    async def body(client):
        batch = (await client.post("/api/uploads/docs", headers=AUTH, json={"name": "empty"})).json()["batch"]
        return (await client.post(f"/api/uploads/docs/{batch}/done", headers=AUTH)).json()
    assert "none of those files" in client_for(tmp_path, body)["error"]
    assert not (tmp_path / "uploads" / "docs" / "empty").exists()


# ---------------------------------------------------------------------------
# Books and voices
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["../escape.pdf", "..", ".hidden.pdf", "a\\b.pdf", "x\x00.pdf", ""])
def test_a_hostile_book_name_is_refused_or_reduced_to_a_plain_file_name(tmp_path, name):
    root = tmp_path / "uploads"
    try:
        target = up.book_target(root, name)
    except up.UploadError:
        return
    assert target.parent == (root / "books").resolve()


def test_only_a_pdf_is_a_book_and_only_audio_is_a_voice(tmp_path):
    root = tmp_path / "uploads"
    with pytest.raises(up.UploadError, match="not a PDF"):
        up.book_target(root, "novel.epub")
    with pytest.raises(up.UploadError, match="not an audio file"):
        up.voice_target(root, "notes.pdf")
    assert up.voice_target(root, "me.m4a").parent == (root / "voices").resolve()


def test_books_and_voices_upload_note_themselves_and_stay_out_of_the_meeting_list(tmp_path):
    async def body(client):
        book = (await client.put("/api/uploads/book?name=Novel.pdf", headers=AUTH, content=b"%PDF")).json()
        again = (await client.put("/api/uploads/book?name=Novel.pdf", headers=AUTH, content=b"%PDF2")).json()
        voice = (await client.put("/api/uploads/voice?name=me.m4a", headers=AUTH, content=b"audio")).json()
        bad = (await client.put("/api/uploads/book?name=Novel.epub", headers=AUTH, content=b"x")).json()
        state = (await client.get("/api/state", headers=AUTH)).json()
        listed = (await client.get("/api/uploads", headers=AUTH)).json()
        return book, again, voice, bad, state, listed

    book, again, voice, bad, state, listed = client_for(tmp_path, body)
    assert book["name"] == "Novel.pdf" and again["name"] == "Novel (2).pdf"
    assert "not a PDF" in bad["error"]
    assert any("book (PDF) Novel.pdf" in n and book["path"] in n for n in state["notes"])
    assert any("clone a voice" in n and voice["path"] in n for n in state["notes"])
    assert {b["name"] for b in listed["books"]} == {"Novel.pdf", "Novel (2).pdf"}
    assert [v["name"] for v in listed["voices"]] == ["me.m4a"]
    assert listed["audio"] == []  # a voice sample is not a meeting to transcribe


def test_the_book_and_voice_endpoints_need_the_token(tmp_path):
    async def body(client):
        return [(await client.put(f"/api/uploads/{kind}?name=a.{ext}", content=b"x")).status_code
                for kind, ext in (("book", "pdf"), ("voice", "m4a"))]
    assert client_for(tmp_path, body) == [401, 401]


# ---------------------------------------------------------------------------
# Audio a tool made: served only from folders tools.yaml declared
# ---------------------------------------------------------------------------

class Serving(ToolRegistry):
    """A registry that declares media folders without launching any tool."""

    def __init__(self, roots, local):
        super().__init__([], local=local)
        self._roots = roots

    @property
    def media_roots(self):
        return self._roots


def media_client(tmp_path, body):
    app = create_app(tmp_path / "tools.yaml", tmp_path / "memory.json", tmp_path / "audit.jsonl", token=TOKEN,
                     registry_factory=lambda local: Serving([tmp_path / "output"], local), watch_jobs=False)
    return run(with_client(app, body))


def test_audio_in_a_declared_folder_is_served_and_nothing_else_is(tmp_path):
    out = tmp_path / "output" / "book"
    out.mkdir(parents=True)
    (out / "01.mp3").write_bytes(b"ID3audio")
    (out / "notes.txt").write_text("not audio")
    (tmp_path / "secret.mp3").write_bytes(b"outside")
    (tmp_path / "output" / "link.mp3").symlink_to(tmp_path / "secret.mp3")

    async def get(client, path, headers=AUTH):
        return await client.get("/api/files", params={"path": str(path)}, headers=headers)

    async def body(client):
        return {
            "inside": await get(client, out / "01.mp3"),
            "wrong kind": await get(client, out / "notes.txt"),
            "outside": await get(client, tmp_path / "secret.mp3"),
            "traversal": await get(client, out / ".." / ".." / "secret.mp3"),
            "symlink out": await get(client, tmp_path / "output" / "link.mp3"),
            "missing": await get(client, out / "gone.mp3"),
            "nul byte": await get(client, str(out) + "/01.mp3\x00.txt"),
            "no token": await get(client, out / "01.mp3", headers={}),
        }

    got = media_client(tmp_path, body)
    assert got["inside"].status_code == 200 and got["inside"].content == b"ID3audio"
    assert got["inside"].headers["content-type"] == "audio/mpeg"
    assert {k: v.status_code for k, v in got.items() if k not in ("inside", "no token")} == {
        "wrong kind": 404, "outside": 404, "traversal": 404, "symlink out": 404, "missing": 404, "nul byte": 404}
    assert got["no token"].status_code == 401


def test_with_no_declared_folders_nothing_is_served(tmp_path):
    (tmp_path / "output").mkdir()
    (tmp_path / "output" / "a.mp3").write_bytes(b"x")

    async def body(client):
        return (await client.get("/api/files", params={"path": str(tmp_path / "output" / "a.mp3")}, headers=AUTH)).status_code
    assert client_for(tmp_path, body) == 404
