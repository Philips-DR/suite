import pytest

from audiobook.plan import continues_sentence, is_front_matter, normalise, parse_heading, strip_citations


@pytest.mark.parametrize(
    "text, number, title, level",
    [
        ("1. Introduction", "1", "Introduction", 1),
        ("1 Introduction", "1", "Introduction", 1),
        ("5.1. Main Results across Benchmarks", "5.1", "Main Results across Benchmarks", 2),
        ("E.4.1. HotpotQA: Emergent Simplicity", "E.4.1", "HotpotQA: Emergent Simplicity", 3),
        ("A. Extended Related Work", "A", "Extended Related Work", 1),
        ("IV. The Storm", "IV", "The Storm", 1),
        ("References", None, "References", 1),
        ("Chapter 3: The Letter", None, "Chapter 3: The Letter", 1),
        ("A Tale of Two Cities", None, "A Tale of Two Cities", None),
        ("Step 45 (Month 31):", None, "Step 45 (Month 31):", None),
    ],
)
def test_parse_heading(text, number, title, level):
    h = parse_heading(text)
    assert (h.number, h.title, h.level) == (number, title, level)


@pytest.mark.parametrize(
    "text, expected, count",
    [
        ("act through tools (Qin et al., 2024; Sumers et al., 2023). Most", "act through tools. Most", 1),
        ("ReAct (Yao et al., 2023b) interleaves", "ReAct interleaves", 1),
        ("Sumers et al. (2023) propose CoALA", "Sumers et al. propose CoALA", 1),
        ("workflows (Xiao et al.,2024; Zhang et al., 2023). Next", "workflows. Next", 1),  # OCR drops spaces
        ("as shown before [12], and [3, 7-9].", "as shown before, and.", 2),
        # Ordinary parentheses and bracketed numbers survive.
        ("the graph (Section 3.2) is frozen", "the graph (Section 3.2) is frozen", 0),
        ("a gain (a 14.0-point gain) here", "a gain (a 14.0-point gain) here", 0),
        ("intervals [71.83, 77.37] shown", "intervals [71.83, 77.37] shown", 0),
        ("founded (in 1998) by", "founded (in 1998) by", 0),
    ],
)
def test_strip_citations(text, expected, count):
    assert strip_citations(text) == (expected, count)


def test_normalise_math_and_ligatures():
    assert normalise("𝑆val(G𝑘)  eﬃcient\n text") == "Sval(Gk) efficient text"


def test_normalise_zero_for_letter_o():
    assert normalise("The Return 0f The Eagles, 0n time") == "The Return of The Eagles, on time"
    # Numbers are untouched.
    assert normalise("about 11.0k and 6.0k tokens, 10x, 0 errors") == "about 11.0k and 6.0k tokens, 10x, 0 errors"


@pytest.mark.parametrize(
    "text, expected",
    [("and able to improve", True), ("Φ(e) of the edges", True), ("The next paragraph", False), ("2 things", False)],
)
def test_continues_sentence(text, expected):
    assert continues_sentence(text) is expected


def test_front_matter():
    assert is_front_matter("Yuxing Lu 1,2,3 , Yicheng Chen 1 and Sercan Ö. Arık 1")
    assert is_front_matter("1 Google, 2 Georgia Institute of Technology")
    assert not is_front_matter("Large language models are deployed as agents.")
