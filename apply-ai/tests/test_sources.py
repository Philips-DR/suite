import pytest

from applyai.sources import CONFIRMED, SourceError, gather, read_source, roots_from_environment, units


def test_units_are_headings_bullets_and_paragraphs_with_markdown_stripped():
    text = "# Name\n\n**Title** line\ncontinues here\\\nand here\n\n- **Bold:** a [link](https://x.org) and `code`\n- second\n"
    assert units(text) == ["Name", "Title line continues here and here", "Bold: a link and code", "second"]


def test_a_long_paragraph_becomes_sentences_so_a_figure_is_checked_against_its_own_sentence():
    text = "A" * 10 + " first sentence is here. " + "Second sentence reached 94% precision. " * 6
    assert len(units(text)) > 1


def test_reads_are_confined_to_the_named_folders(tmp_path):
    inside = tmp_path / "docs" / "cv.md"
    inside.parent.mkdir()
    inside.write_text("- Python\n")
    outside = tmp_path.parent / "outside.md"
    outside.write_text("secret\n")
    assert read_source(str(inside), [tmp_path / "docs"])[1][0].text == "Python"
    with pytest.raises(SourceError, match="only documents in the uploads folder"):
        read_source(str(outside), [tmp_path / "docs"])
    with pytest.raises(SourceError, match="only documents in the uploads folder"):
        read_source(str(tmp_path / "docs" / ".." / ".." / "outside.md"), [tmp_path / "docs"])  # `..` is resolved first


def test_a_symlink_out_of_the_folder_is_refused(tmp_path):
    (tmp_path / "docs").mkdir()
    target = tmp_path / "elsewhere.md"
    target.write_text("x\n")
    (tmp_path / "docs" / "link.md").symlink_to(target)
    with pytest.raises(SourceError):
        read_source(str(tmp_path / "docs" / "link.md"), [tmp_path / "docs"])


def test_only_text_and_markdown_and_only_files_that_exist(tmp_path):
    (tmp_path / "a.pdf").write_bytes(b"%PDF")
    with pytest.raises(SourceError, match="no markdown or text file"):
        read_source(str(tmp_path / "a.pdf"), [tmp_path])
    with pytest.raises(SourceError, match="no markdown or text file"):
        read_source(str(tmp_path / "missing.md"), [tmp_path])


def test_confirmed_facts_are_material_named_as_confirmed(tmp_path):
    (tmp_path / "cv.md").write_text("- Python\n")
    lines = gather([str(tmp_path / "cv.md")], ["The crop images were from **drones**"], [tmp_path])
    assert [(ln.source, ln.text) for ln in lines] == [("cv.md", "Python"), (CONFIRMED, "The crop images were from drones")]


def test_nothing_to_check_against_is_an_error_not_an_empty_pass(tmp_path):
    with pytest.raises(SourceError, match="no source material"):
        gather([], [], [tmp_path])


def test_roots_come_from_the_environment_or_default_to_the_working_folder(monkeypatch, tmp_path):
    monkeypatch.setenv("APPLY_AI_ROOTS", f"{tmp_path}:/data/uploads")
    assert [str(r) for r in roots_from_environment()] == [str(tmp_path), "/data/uploads"]
    monkeypatch.delenv("APPLY_AI_ROOTS")
    assert roots_from_environment()[0].is_absolute()


# A draft the assistant wrote is not the user's word. Found when the model, on a second application, passed
# its own earlier cover letter and CV as "sources": a claim made once became supported by itself.
def test_a_draft_the_assistant_wrote_is_not_the_users_material(tmp_path):
    batch = tmp_path / "docs" / "Cover Letter - AfricaRice"
    batch.mkdir(parents=True)
    (batch / "Cover Letter - AfricaRice.md").write_text("- Required extensive data cleaning.\n")
    (batch / ".draft").write_text("written by the assistant, not by the user\n")
    with pytest.raises(SourceError, match="a draft the assistant wrote, not the user's own material"):
        read_source(str(batch / "Cover Letter - AfricaRice.md"), [tmp_path])
    with pytest.raises(SourceError, match="Use the documents the user uploaded"):
        gather([str(batch / "Cover Letter - AfricaRice.md")], ["a fact"], [tmp_path])


def test_a_document_the_user_uploaded_has_no_such_marker_and_reads_normally(tmp_path):
    batch = tmp_path / "docs" / "01-resume"
    batch.mkdir(parents=True)
    (batch / "01-resume.md").write_text("- Python\n")
    assert read_source(str(batch / "01-resume.md"), [tmp_path])[1][0].text == "Python"
