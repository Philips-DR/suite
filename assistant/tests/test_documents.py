"""Tests for reading and drafting documents. Confinement first: the model chooses the path."""

import asyncio
import json

from assistant.documents import document_tools
from assistant.tools import ToolRegistry


def tools_for(root):
    return {t.name: t for t in document_tools(root)}


def call(tool, **arguments):
    return json.loads(asyncio.run(tool.handler(arguments)))


def test_a_read_cannot_leave_the_uploads_folder(tmp_path):
    root = tmp_path / "uploads"
    (root / "docs" / "cv").mkdir(parents=True)
    (tmp_path / "secret.md").write_text("private")
    read = tools_for(root)["read_document"]
    assert "only documents in the uploads folder" in call(read, path=str(tmp_path / "secret.md"))["error"]
    assert "only documents in the uploads folder" in call(read, path=str(root / ".." / "secret.md"))["error"]


def test_only_markdown_is_read(tmp_path):
    root = tmp_path / "uploads"
    (root / "audio").mkdir(parents=True)
    (root / "audio" / "a.m4a").write_bytes(b"x")
    assert "no markdown file" in call(tools_for(root)["read_document"], path=str(root / "audio" / "a.m4a"))["error"]


def test_an_uploaded_document_reads_back_whole(tmp_path):
    root = tmp_path / "uploads"
    (root / "docs" / "cv").mkdir(parents=True)
    (root / "docs" / "cv" / "cv.md").write_text("# Ama Mensah\n\nData engineer, 4 years.\n")
    read = call(tools_for(root)["read_document"], path=str(root / "docs" / "cv" / "cv.md"))
    assert read["text"].startswith("# Ama Mensah") and read["truncated"] is False


def test_a_draft_is_always_a_new_file_and_never_overwrites(tmp_path):
    """The original must survive to be compared against -- and so must an earlier draft."""
    root = tmp_path / "uploads"
    write = tools_for(root)["write_draft"]
    first = call(write, title="CV - ML engineer", markdown="# Ama\n\nv1")
    second = call(write, title="CV - ML engineer", markdown="# Ama\n\nv2")
    assert first["path"] != second["path"]
    assert open(first["path"]).read() == "# Ama\n\nv1\n"
    assert second["title"] == "CV - ML engineer (2)"


def test_an_empty_draft_is_refused(tmp_path):
    assert call(tools_for(tmp_path)["write_draft"], title="x", markdown="  ")["error"] == "the draft is empty"


def test_the_approval_shows_the_draft_itself_not_a_json_string(tmp_path):
    """A person approves what they have read; a whole CV escaped into JSON cannot be read."""
    async def body():
        async with ToolRegistry([], local=document_tools(tmp_path)) as registry:
            tool = registry.find("assistant__write_draft")
            preview = await registry.preview_of(tool, {"title": "CV", "markdown": "# Ama\n\n- Python"})
            return tool, preview
    tool, preview = asyncio.run(body())
    assert tool.read_only is False and tool.preview is not None  # gated, with a preview promised
    assert preview == "New file: CV.md\n\n# Ama\n\n- Python"


def test_a_rewrite_shows_what_it_left_out_above_the_draft(tmp_path):
    """Found live: a 'tailored' CV silently stopped after its first project, and its reply
    said it had only reordered. The approval now says what is missing, measured."""
    root = tmp_path / "uploads"
    (root / "docs" / "cv").mkdir(parents=True)
    original = root / "docs" / "cv" / "cv.md"
    original.write_text("# Ama\n\n## Experience\n\n- a\n- b\n\n## Skills\n\n- Python\n\n## Education\n\n- BSc\n")
    args = {"title": "CV - ML", "markdown": "# Ama\n\n## Experience\n\n- a\n", "based_on": str(original)}

    async def body():
        async with ToolRegistry([], local=document_tools(root)) as registry:
            return await registry.preview_of(registry.find("assistant__write_draft"), args)
    preview = asyncio.run(body())
    assert "sections missing or renamed: Skills, Education" in preview
    assert "Points kept: 1 of 4" in preview

    saved = call(tools_for(root)["write_draft"], **args)
    assert saved["compared_with_original"]["missing_sections"] == ["Skills", "Education"]


def test_uploads_can_be_found_without_a_path_in_the_conversation(tmp_path):
    """Found live: after a restart the upload's note was gone, and asked to make a CV the
    assistant asked for an upload that was already there -- it had no way to look."""
    root = tmp_path / "uploads"
    (root / "docs" / "01-resume").mkdir(parents=True)
    (root / "docs" / "01-resume" / "01-resume.md").write_text("# Ama\n")
    listed = call(tools_for(root)["list_uploads"])
    assert listed["documents"][0]["path"].endswith("01-resume/01-resume.md")


# A draft the assistant wrote is marked, and list_uploads says so. A tool that checks a draft against "the
# user's own material" (apply-ai) refuses a marked folder: found when the model passed its own earlier cover
# letter as a source and a claim it had made became supported by itself.
def test_a_draft_is_marked_as_the_assistants_own_and_an_upload_is_not(tmp_path):
    root = tmp_path / "uploads"
    (root / "docs" / "01-resume").mkdir(parents=True)
    (root / "docs" / "01-resume" / "01-resume.md").write_text("# Ama\n")
    tools = tools_for(root)
    written = call(tools["write_draft"], title="CV - Role", markdown="# Ama\n\n- Built things.\n")
    assert (root / "docs" / "CV - Role" / ".draft").is_file()
    listed = {d["name"]: d["draft"] for d in call(tools["list_uploads"])["documents"]}
    assert listed == {"CV - Role": True, "01-resume": False}
    assert written["path"].endswith("CV - Role.md")


def test_the_listing_tells_the_model_what_draft_means(tmp_path):
    description = tools_for(tmp_path / "uploads")["list_uploads"].description
    assert "draft: true" in description and "never the user's own material" in description
