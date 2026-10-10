"""Golden test: the full preview of the test paper, from a saved Docling result.

Any change to the plan rules shows up as a readable diff of tests/golden/paper.preview.md.
To accept an intended change: UPDATE_GOLDEN=1 pytest tests/test_golden.py
"""

import gzip
import os
from pathlib import Path

from docling_core.types.doc import DoclingDocument

from audiobook.plan import build_plan
from audiobook.preview import render_preview

HERE = Path(__file__).parent
FIXTURE = HERE / "fixtures/paper.docling.json.gz"
GOLDEN = HERE / "golden/paper.preview.md"


def paper_plan():
    doc = DoclingDocument.model_validate_json(gzip.decompress(FIXTURE.read_bytes()))
    return build_plan(doc, fallback_title="2609.09153v1")


def test_paper_preview_matches_golden():
    actual = render_preview(paper_plan(), "2609.09153v1.pdf")
    if os.environ.get("UPDATE_GOLDEN") or not GOLDEN.exists():
        GOLDEN.write_text(actual)
    assert actual == GOLDEN.read_text()


def test_paper_structure():
    plan = paper_plan()
    assert plan.title == "Procedural Graphs: Self-Evolving Execution Structures for LLM Agents"
    assert [c.title for c in plan.chapters] == [
        "Opening",
        "Introduction",
        "Related Work",
        "The Procedural Graph Framework",
        "Experimental Setup",
        "Results",
        "Conclusion",
        "Extended Related Work and Comparison",
        "Experimental Details",
        "Long-Horizon Analysis on EnterpriseArena",
        "Procedural Graph Construction: Supplementary Results",
        "Round-by-Round Self-Evolution on EnterpriseArena",
        "Additional Execution Cases",
    ]
    assert [c.appendix for c in plan.chapters] == [False] * 7 + [True] * 6


def test_paper_nothing_unreadable_is_spoken():
    spoken = "\n".join(s.text for c in paper_plan().chapters for s in c.segments)
    for leftover in ("et al., 20", "Corresponding author", "arXiv:2609", "Table 1 |", "Figure 1 |", "Besta, N. Blach"):
        assert leftover not in spoken, leftover
    # The paragraph split by Figure 1 is rejoined.
    assert "responsive to its current progress, and able to improve from experience" in spoken
