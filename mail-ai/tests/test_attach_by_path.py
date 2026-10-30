"""Attaching a file by its path (2026-10-30). The path comes from a model, so it is hostile: only a plain file
inside the one folder this tool was given may be read, and the send check covers its bytes like any other file's."""

import asyncio  # noqa: F401  (the door helpers below run the server's coroutines)

import pytest

from mailai.attach import read_attachment
from mailai.auth import COMPOSE_SCOPES, AuthConfig
from mailai.compose import MAX_ATTACHMENTS_BYTES, Attachment, BadAttachment, check_total
from mailai.mcp_server import ServerPaths, create_mail_ai_server
from tests.test_mcp_door import call, gmail, store_path  # noqa: F401  (fixtures)

CV = b"PK\x03\x04 a word cv"


@pytest.fixture
def exports(tmp_path):
    folder = tmp_path / "exports"
    folder.mkdir()
    (folder / "Philip_Baah_Afriyie_CV.docx").write_bytes(CV)
    return folder


# ---------------------------------------------------------------------------
# Reading a file by path
# ---------------------------------------------------------------------------

def test_a_file_in_the_folder_is_read_whole_and_keeps_its_name(exports):
    file = read_attachment(str(exports / "Philip_Baah_Afriyie_CV.docx"), exports)
    assert (file.filename, file.data) == ("Philip_Baah_Afriyie_CV.docx", CV)


def test_a_name_can_be_given_and_a_relative_path_is_taken_inside_the_folder(exports):
    file = read_attachment("Philip_Baah_Afriyie_CV.docx", exports, filename="CV.docx")
    assert (file.filename, file.data) == ("CV.docx", CV)


def test_a_file_outside_the_folder_is_refused(exports, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"not for mailing")
    for path in (str(secret), "../secret.txt", str(exports / ".." / "secret.txt"), "/etc/hostname"):
        with pytest.raises(BadAttachment):
            read_attachment(path, exports)


def test_a_link_is_refused_wherever_it_points(exports, tmp_path):
    outside = tmp_path / "outside.docx"
    outside.write_bytes(b"elsewhere")
    (exports / "out.docx").symlink_to(outside)
    (exports / "in.docx").symlink_to(exports / "Philip_Baah_Afriyie_CV.docx")
    for name in ("out.docx", "in.docx"):
        with pytest.raises(BadAttachment, match="link"):
            read_attachment(str(exports / name), exports)


def test_a_folder_is_not_a_file_to_attach(exports):
    (exports / "sub").mkdir()
    with pytest.raises(BadAttachment, match="not a file"):
        read_attachment(str(exports / "sub"), exports)


def test_a_missing_file_an_empty_path_and_no_folder_are_each_refused(exports):
    with pytest.raises(BadAttachment, match="no file"):
        read_attachment(str(exports / "ghost.docx"), exports)
    with pytest.raises(BadAttachment, match="needs a path"):
        read_attachment("  ", exports)
    with pytest.raises(BadAttachment, match="no folder"):
        read_attachment(str(exports / "Philip_Baah_Afriyie_CV.docx"), None)


def test_an_empty_file_is_refused_as_any_empty_file_is(exports):
    (exports / "empty.pdf").write_bytes(b"")
    with pytest.raises(BadAttachment, match="empty"):
        read_attachment(str(exports / "empty.pdf"), exports)


def test_a_file_over_the_limit_is_refused_before_it_is_read(exports):
    big = exports / "big.pdf"
    with big.open("wb") as handle:
        handle.truncate(MAX_ATTACHMENTS_BYTES + 1)  # sparse: says its size without being written
    with pytest.raises(BadAttachment, match="MB"):
        read_attachment(str(big), exports)


def test_files_that_come_to_more_than_the_limit_together_are_refused():
    half = MAX_ATTACHMENTS_BYTES // 2 + 1
    with pytest.raises(BadAttachment, match="in all"):
        check_total([Attachment("a.pdf", b"x" * half), Attachment("b.pdf", b"x" * half)])
    check_total([Attachment("a.pdf", b"x" * (half - 2)), Attachment("b.pdf", b"x" * (half - 2))])  # just under


# ---------------------------------------------------------------------------
# Through the door
# ---------------------------------------------------------------------------

@pytest.fixture
def door(store_path, tmp_path, exports):
    return create_mail_ai_server(
        ServerPaths(store=store_path, attach_root=exports),
        AuthConfig(credentials_path=tmp_path / "c.json", token_path=tmp_path / "t.json"),
        AuthConfig(credentials_path=tmp_path / "c.json", token_path=tmp_path / "tc.json", scopes=tuple(COMPOSE_SCOPES)),
    )


def draft(server, attachments):
    return call(server, "draft_new", to="hr@example.org", subject="Application", body="Attached.",
                attachments=attachments)


def test_a_file_by_path_is_drafted_reviewed_and_covered_by_the_confirmation(door, gmail, exports):
    made = draft(door, [{"path": str(exports / "Philip_Baah_Afriyie_CV.docx")}])
    assert made["attachments"] == [{"filename": "Philip_Baah_Afriyie_CV.docx", "size": len(CV)}]
    reviewed = call(door, "review_draft", draft_id=made["draft_id"])
    assert reviewed["confirmation"] == made["confirmation"]
    assert f"Philip_Baah_Afriyie_CV.docx ({len(CV)} bytes)" in reviewed["rendered"]
    # and swapping the file in Gmail afterwards still stops the send
    gmail.replace_attachment(made["draft_id"], "Philip_Baah_Afriyie_CV.docx", b"PK\x03\x04 another cv")
    assert "error" in call(door, "send_draft", draft_id=made["draft_id"], confirmation=reviewed["confirmation"])
    assert gmail.sent == []


def test_a_path_and_bytes_can_sit_side_by_side(door, gmail, exports):
    import base64

    made = draft(door, [{"path": "Philip_Baah_Afriyie_CV.docx"},
                        {"filename": "note.txt", "data": base64.b64encode(b"hello").decode()}])
    assert [a["filename"] for a in made["attachments"]] == ["Philip_Baah_Afriyie_CV.docx", "note.txt"]


@pytest.mark.parametrize("attachments", [
    [{"path": "../secret.txt"}],                                          # outside the folder
    [{"path": "Philip_Baah_Afriyie_CV.docx", "data": "UEs="}],            # both: which is meant?
    [{"filename": "cv.docx"}],                                            # neither
    [{"path": "Philip_Baah_Afriyie_CV.docx"}, {"path": "ghost.docx"}],    # one good, one missing: no draft
])
def test_a_refused_path_makes_no_draft(door, gmail, tmp_path, attachments):
    (tmp_path / "secret.txt").write_bytes(b"not for mailing")
    assert "error" in draft(door, attachments)
    assert gmail.store == {}


def test_without_a_folder_no_file_can_be_attached_by_path(store_path, tmp_path, gmail, exports):
    server = create_mail_ai_server(
        ServerPaths(store=store_path),
        AuthConfig(credentials_path=tmp_path / "c.json", token_path=tmp_path / "t.json"),
        AuthConfig(credentials_path=tmp_path / "c.json", token_path=tmp_path / "tc.json", scopes=tuple(COMPOSE_SCOPES)),
    )
    assert "no folder" in draft(server, [{"path": str(exports / "Philip_Baah_Afriyie_CV.docx")}])["error"]
    assert gmail.store == {}


def test_the_door_tells_a_model_to_attach_by_path_and_not_to_carry_bytes(door):
    tool = next(t for t in asyncio.run(door.list_tools()) if t.name == "draft_new")
    assert "docu_ai__save_export" in tool.description and "{path}" in tool.description
    item = tool.input_schema["$defs"]["AttachmentArgument"]  # what each item of `attachments` refers to
    assert "path" in item["properties"] and item.get("required", []) == []


def test_files_over_the_limit_together_make_no_draft(door, gmail, exports):
    """Each file is under the limit; together they are not. The total is checked before Gmail is asked."""
    for name in ("a.pdf", "b.pdf"):
        with (exports / name).open("wb") as handle:
            handle.truncate(MAX_ATTACHMENTS_BYTES // 2 + 1)
    assert "in all" in draft(door, [{"path": "a.pdf"}, {"path": "b.pdf"}])["error"]
    assert gmail.store == {}
