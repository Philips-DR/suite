"""Deleting a book's audio. The name comes from a model or a browser, so it is hostile until checked, and the
one folder it may name sits beside `output/voices`, which holds voice samples and must never go."""

import asyncio
import json
from pathlib import Path

import pytest

from audiobook import background, operations
from audiobook.background import Job
from audiobook.mcp_server import ServerPaths, create_audiobook_server


@pytest.fixture
def output(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # output/ is relative to the tool's own folder
    (tmp_path / "output").mkdir()
    return tmp_path / "output"


def make(folder: Path, *names, size=10):
    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        (folder / name).write_bytes(b"x" * size)
    return folder


def running(monkeypatch, kind="render", target="/books/novel.pdf"):
    job = Job(id="j1", kind=kind, target=target, log="", started_at="now", state="running")
    monkeypatch.setattr(background, "current", lambda jobs_dir: job)


def idle(monkeypatch):
    monkeypatch.setattr(background, "current", lambda jobs_dir: None)


def test_one_books_folder_goes_and_its_neighbours_stay(output, tmp_path, monkeypatch):
    idle(monkeypatch)
    make(output / "novel", "chapter-1.mp3", "novel.m4b", "preview.md")
    other = make(output / "paper", "paper.mp3")
    voices = make(output / "voices", "abigail-test.mp3")
    done = operations.delete_audiobook("novel", tmp_path / "jobs")
    assert done == {"book": "novel", "deleted": True, "files": 3, "bytes": 30}
    assert not (output / "novel").exists() and other.exists() and voices.exists()


@pytest.mark.parametrize("book", ["..", ".", "../x", "a/b", "a\\b", "x\x00", "", " novel", ".hidden", "/etc"])
def test_a_hostile_name_removes_nothing(output, tmp_path, monkeypatch, book):
    idle(monkeypatch)
    kept = make(output / "novel", "a.mp3")
    with pytest.raises(ValueError):
        operations.delete_audiobook(book, tmp_path / "jobs")
    assert kept.exists()


def test_the_voice_samples_folder_is_never_a_book(output, tmp_path, monkeypatch):
    """`list_audiobooks` lists output/voices as a book once a sample exists. It is not one."""
    idle(monkeypatch)
    sample = make(output / "voices", "abigail-test.mp3")
    assert any(b["book"] == "voices" for b in operations.list_audiobooks())  # the trap is real
    with pytest.raises(ValueError, match="voice samples"):
        operations.delete_audiobook("voices", tmp_path / "jobs")
    with pytest.raises(ValueError, match="voice samples"):
        operations.describe_audiobook("voices", tmp_path / "jobs")
    assert sample.exists()


def test_a_link_to_a_folder_elsewhere_is_left_alone(output, tmp_path, monkeypatch):
    idle(monkeypatch)
    elsewhere = make(tmp_path / "elsewhere", "precious.mp3")
    (output / "novel").symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(ValueError, match="link"):
        operations.delete_audiobook("novel", tmp_path / "jobs")
    assert (elsewhere / "precious.mp3").exists()


def test_a_folder_holding_anything_but_files_is_left_exactly_as_it_was(output, tmp_path, monkeypatch):
    idle(monkeypatch)
    make(output / "novel", "a.mp3")
    make(output / "novel" / "sub", "b.mp3")
    with pytest.raises(ValueError, match="left alone"):
        operations.delete_audiobook("novel", tmp_path / "jobs")
    assert (output / "novel" / "a.mp3").exists() and (output / "novel" / "sub" / "b.mp3").exists()


def test_a_link_inside_the_folder_is_not_followed(output, tmp_path, monkeypatch):
    idle(monkeypatch)
    outside = make(tmp_path / "outside", "precious.mp3") / "precious.mp3"
    make(output / "novel", "a.mp3")
    (output / "novel" / "link.mp3").symlink_to(outside)
    with pytest.raises(ValueError, match="left alone"):
        operations.delete_audiobook("novel", tmp_path / "jobs")
    assert outside.exists() and (output / "novel" / "a.mp3").exists()


@pytest.mark.parametrize("kind", ["render", "analyse"])
def test_a_book_being_read_or_rendered_is_not_deleted(output, tmp_path, monkeypatch, kind):
    running(monkeypatch, kind=kind, target="/uploads/books/novel.pdf")
    kept = make(output / "novel", "a.mp3")
    with pytest.raises(background.JobError, match="running"):
        operations.delete_audiobook("novel", tmp_path / "jobs")
    assert kept.exists()


def test_a_job_on_another_book_or_a_voice_does_not_block_this_one(output, tmp_path, monkeypatch):
    make(output / "novel", "a.mp3")
    running(monkeypatch, kind="render", target="/books/paper.pdf")
    assert operations.delete_audiobook("novel", tmp_path / "jobs")["deleted"] is True
    make(output / "novel", "a.mp3")
    running(monkeypatch, kind="voice", target="novel")  # a voice that happens to share the name
    assert operations.delete_audiobook("novel", tmp_path / "jobs")["deleted"] is True


def test_deleting_what_is_not_there_removes_nothing_and_says_so(output, tmp_path, monkeypatch):
    idle(monkeypatch)
    assert operations.delete_audiobook("ghost", tmp_path / "jobs") == {"book": "ghost", "deleted": False, "files": 0, "bytes": 0}


def test_the_description_names_each_file_and_says_what_stays(output, tmp_path, monkeypatch):
    idle(monkeypatch)
    make(output / "novel", "chapter-1.mp3", "novel.m4b", size=2_000_000)
    d = operations.describe_audiobook("novel", tmp_path / "jobs")
    assert d["exists"] and d["bytes"] == 4_000_000 and d["running"] is None
    assert "chapter-1.mp3 (2.0 MB)" in d["summary"] and "novel.m4b (2.0 MB)" in d["summary"]
    assert "only these files" in d["summary"] and "voice" in d["summary"] and "caches" in d["summary"]


def test_the_description_warns_when_the_book_is_busy_and_is_honest_when_nothing_is_stored(output, tmp_path, monkeypatch):
    running(monkeypatch, target="/uploads/books/novel.pdf")
    make(output / "novel", "a.mp3")
    assert "is running" in operations.describe_audiobook("novel", tmp_path / "jobs")["summary"]
    idle(monkeypatch)
    nothing = operations.describe_audiobook("ghost", tmp_path / "jobs")
    assert nothing["exists"] is False and "Nothing is stored" in nothing["summary"]


def test_through_the_door_a_failure_is_data_and_a_delete_works(output, tmp_path, monkeypatch):
    idle(monkeypatch)
    server = create_audiobook_server(ServerPaths(jobs_dir=tmp_path / "jobs"))

    def call(tool, **arguments):
        result = asyncio.run(server.call_tool(tool, arguments))
        return json.loads("".join(block.text for block in result.content if block.type == "text"))

    make(output / "novel", "a.mp3")
    assert "not the name of a book" in call("delete_audiobook", book="../etc")["error"]
    assert call("describe_audiobook", book="novel")["exists"] is True
    assert call("delete_audiobook", book="novel") == {"book": "novel", "deleted": True, "files": 1, "bytes": 10}
    assert not (output / "novel").exists()


def test_a_link_to_another_book_is_not_followed_into_it(output, tmp_path, monkeypatch):
    """Without the link check this one passes every location test: the link resolves to a real folder directly
    inside output/, and the other book is what would be emptied."""
    idle(monkeypatch)
    other = make(output / "paper", "paper.mp3")
    (output / "novel").symlink_to(output / "paper", target_is_directory=True)
    with pytest.raises(ValueError, match="link"):
        operations.delete_audiobook("novel", tmp_path / "jobs")
    assert (other / "paper.mp3").exists()
