"""The Final Quest (Rick Joyner): a real book, to keep the rules honest beyond arXiv papers.

The book is copyrighted, so its Docling fixture lives in the git-ignored tests/fixtures/local/ and
these tests skip when it's absent.
"""

import gzip
from pathlib import Path

import pytest
from docling_core.types.doc import DoclingDocument

from audiobook.plan import build_plan

FIXTURE = Path(__file__).parent / "fixtures/local/final-quest.docling.json.gz"
pytestmark = pytest.mark.skipif(not FIXTURE.exists(), reason="local book fixture not present")


@pytest.fixture(scope="module")
def plan():
    doc = DoclingDocument.model_validate_json(gzip.decompress(FIXTURE.read_bytes()))
    return build_plan(doc, fallback_title="The Final Quest", author="Rick Joyner")


def test_chapters_follow_the_books_contents(plan):
    assert [c.title for c in plan.chapters] == [
        "Introduction",
        "Part I, The Hordes of Hell Are Marching",
        "Part II, The Holy Mountain",
        "Part III, The Return of The Eagles",  # the PDF says "0f"
        "Part IV, The White Throne",
        "Part V, The Overcomers",
    ]
    headings = [s.text for c in plan.chapters for s in c.segments if s.kind == "heading"]
    assert len(headings) == 30 and headings[0] == "How I Received The Vision"


def test_dialogue_at_page_foot_is_read(plan):
    spoken = "\n".join(s.text for c in plan.chapters for s in c.segments)
    # Docling labels these as footnotes.
    assert '"Grace," my angel responded.' in spoken
    assert '"But do you want this seat?"' in spoken
    # Split across a page break, and rejoined.
    assert "because all who miss this door do so for the same reason" in spoken


def test_no_paragraph_starts_mid_sentence(plan):
    starts = [s.text for c in plan.chapters for s in c.segments if s.text[0].islower()]
    assert starts == []
