"""Tests for uploads. Security first: this endpoint writes to disk whatever a browser sends,
so every name is hostile until checked."""

import asyncio

import pytest

from assistant import uploads as up
from tests.test_server import AUTH, app_for, run, with_client


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
