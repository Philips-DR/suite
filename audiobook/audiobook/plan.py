"""DoclingDocument → BookPlan: exactly what the narrator will say, chapter by chapter.

Pure: no I/O, no models. Every element that is not spoken is recorded as `Skipped` with a reason,
so the preview can show what was left out and why.
"""

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterator, Literal

from docling_core.types.doc import DoclingDocument

from .speech import apply_corrections, for_speech

# ---------------------------------------------------------------------------------------------
# Data


@dataclass
class Segment:
    kind: Literal["title", "heading", "paragraph", "list_item"]
    text: str
    pages: list[int]
    level: int | None = None  # headings only; None = unnumbered subsection


@dataclass
class Skipped:
    reason: str
    text: str
    page: int | None


@dataclass
class Chapter:
    title: str  # as displayed and tagged
    number: str | None = None
    appendix: bool = False
    segments: list[Segment] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)
    citations_removed: int = 0
    announce: str = ""  # the title as spoken ("Part Three, …" for "Part III, …")

    @property
    def spoken_chars(self) -> int:
        return len(self.announce or self.title) + sum(len(s.text) for s in self.segments)


@dataclass
class BookPlan:
    title: str
    chapters: list[Chapter]
    author: str | None = None


# ---------------------------------------------------------------------------------------------
# Step 1: flatten the Docling tree into a stream of readable items


# Labels never read aloud, with the reason shown in the preview. Their children are skipped too:
# Docling nests table cells and figure text inside the table/picture item.
SKIP_LABELS = {
    "table": "table",
    "picture": "figure",
    "chart": "figure",
    "picture_area": "figure",
    "formula": "formula",
    "code": "code",
    "caption": "caption",
    "footnote": "footnote",
    "page_header": "page header",
    "page_footer": "page footer",
    "document_index": "table of contents",
    "form": "form",
    "form_area": "form",
    "key_value_region": "form",
    "marker": "marker",
}
HEADING_LABELS = {"title", "section_header"}
FOOTNOTE_MARKER = re.compile(r"^([*†‡§]|\d{1,3}\b|\[\d+\])")
# Groups are containers: read their children. Docling uses key_value_area for "Label: prose" runs
# ("Initialization: A human-engineered graph..."), which are real content, not forms.
GROUP_LABELS = {"unspecified", "list", "ordered_list", "chapter", "section", "sheet", "slide", "comment_section", "key_value_area"}


@dataclass
class Item:
    kind: Literal["heading", "text", "list_item", "skip"]
    text: str
    page: int | None
    reason: str = ""


def normalise(text: str) -> str:
    # NFKC turns ligatures and math italics (𝑆 → S) into plain letters.
    text = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip()
    # A zero typed for the letter o at the start of a word ("Return 0f The Eagles").
    return re.sub(r"(?<![\w.,])0(?=[a-z]+\b)", "o", text)


def _page(item) -> int | None:
    prov = getattr(item, "prov", None)
    return prov[0].page_no if prov else None


def walk(doc: DoclingDocument) -> Iterator[Item]:
    skip_below: int | None = None
    for node, depth in doc.iterate_items(with_groups=True):
        if skip_below is not None:
            if depth > skip_below:
                continue
            skip_below = None

        label = str(node.label)
        text = normalise(getattr(node, "text", "") or "")

        if label == "footnote" and text and not FOOTNOTE_MARKER.match(text):
            # Docling labels some lines at the foot of a page as footnotes when they are the story
            # continuing ("\"Grace,\" my angel responded."). Real footnotes start with a marker.
            yield Item("text", text, _page(node))
        elif label in SKIP_LABELS:
            skip_below = depth
            yield Item("skip", text, _page(node), SKIP_LABELS[label])
        elif label == "inline":
            # A paragraph with mixed formatting: Docling splits it into runs; read it as one.
            skip_below = depth
            runs = (normalise(getattr(child.resolve(doc), "text", "") or "") for child in node.children)
            joined = " ".join(r for r in runs if r)
            if joined:
                yield Item("text", joined, _page(node.children[0].resolve(doc)) if node.children else None)
        elif label in GROUP_LABELS or not text:
            continue
        elif label in HEADING_LABELS:
            yield Item("heading", text, _page(node))
        elif label == "list_item":
            yield Item("list_item", text, _page(node))
        else:
            yield Item("text", text, _page(node))


# ---------------------------------------------------------------------------------------------
# Step 2: headings

HEADING_NUMBER = re.compile(r"^(?P<num>(?:\d+|[A-Z]|[IVXLC]+)(?:\.\d+)*)(?P<dot>[.:])?\s+(?P<title>\S.*)$")
TOP_LEVEL_NAMES = re.compile(
    r"^(abstract|introduction|conclusions?|references|bibliography|works cited|acknowledge?ments?|"
    r"appendix|appendices|supplementary|preface|foreword|prologue|epilogue|afterword|"
    r"(chapter|part|book)\b)",
    re.IGNORECASE,
)
SKIP_SECTIONS = re.compile(r"^(references|bibliography|works cited|acknowledge?ments?)$", re.IGNORECASE)
APPENDIX_START = re.compile(r"^(appendix|appendices|supplementary)", re.IGNORECASE)


@dataclass
class Heading:
    number: str | None
    title: str
    level: int | None  # None = unnumbered subsection


def parse_heading(text: str) -> Heading:
    """'5.1. Main Results' → level 2; 'A. Extended Work' → level 1; 'Introduction' → level 1."""
    m = HEADING_NUMBER.match(text)
    if m:
        number = m["num"]
        # A lone letter or roman numeral needs its dot, so "A Tale of Two Cities" isn't numbered.
        if number[0].isdigit() or m["dot"] or "." in number:
            return Heading(number, m["title"], number.count(".") + 1)
    if TOP_LEVEL_NAMES.match(text):
        return Heading(None, text, 1)
    return Heading(None, text, None)


# ---------------------------------------------------------------------------------------------
# Step 3: text clean-up

YEAR = r"(?:19|20)\d{2}[a-z]?"
# (Qin et al., 2024; Sumers et al., 2023) — must start with a capital and end in a year.
PAREN_CITATION = re.compile(rf"\s*\((?:(?:see|e\.g\.,?|cf\.)\s+)?[A-Z][^()]*?,?\s{YEAR}(?:\s*[;,]\s*[^();]*?{YEAR})*\)")
# Sumers et al. (2023) → Sumers et al.
YEAR_ONLY_CITATION = re.compile(rf"\s*\({YEAR}(?:\s*[;,]\s*{YEAR})*\)")
# [12], [3, 7-9]
NUMERIC_CITATION = re.compile(r"\s*\[\d+(?:\s*[,–-]\s*\d+)*\]")
TEMPLATE_PLACEHOLDER = re.compile(r"\{[a-z_]+\}")
SENTENCE_END = re.compile(r"[.!?:;…\"”’)\]]$")


def strip_citations(text: str) -> tuple[str, int]:
    count = 0
    for pattern in (PAREN_CITATION, YEAR_ONLY_CITATION, NUMERIC_CITATION):
        text, n = pattern.subn("", text)
        count += n
    if count:
        text = re.sub(r"\s+([,.;:!?])", r"\1", text)
        text = re.sub(r"\s{2,}", " ", text).strip()
    return text, count


def continues_sentence(text: str) -> bool:
    """True unless the text starts like a new sentence (capital Latin letter or digit)."""
    first = text[0]
    return not (first.isascii() and (first.isupper() or first.isdigit()))


def is_front_matter(text: str) -> bool:
    """Author and affiliation lines: short, and not a sentence."""
    return len(text) < 200 and not SENTENCE_END.search(text)


# ---------------------------------------------------------------------------------------------
# Step 4: assemble chapters


def _drop_empty_headings(chapter: Chapter) -> None:
    """Remove headings with nothing spoken under them (e.g. 'Algorithm 1' followed only by code)."""
    kept: list[Segment] = []
    for i, seg in enumerate(chapter.segments):
        if seg.kind == "heading":
            level = seg.level or 99
            nxt = chapter.segments[i + 1] if i + 1 < len(chapter.segments) else None
            # Two unnumbered headings in a row may be parent and child ("Baseline Agent Trace" then
            # "Step 45"); numbering can't tell, so keep the first.
            both_unnumbered = nxt is not None and seg.level is None and nxt.level is None
            if nxt is None or (nxt.kind == "heading" and (nxt.level or 99) <= level and not both_unnumbered):
                chapter.skipped.append(Skipped("empty section", seg.text, seg.pages[0] if seg.pages else None))
                continue
        kept.append(seg)
    chapter.segments = kept


def build_plan(
    doc: DoclingDocument, fallback_title: str, author: str | None = None, corrections: list[tuple[str, str]] = ()
) -> BookPlan:
    items = list(walk(doc))
    headings = {id(it): parse_heading(it.text) for it in items if it.kind == "heading"}

    # If nothing looks like a top-level heading, every heading starts a chapter.
    if not any(h.level == 1 for h in headings.values()):
        for h in headings.values():
            h.level = 1

    title = fallback_title
    opening = Chapter("Opening")
    chapters = [opening]
    current = opening
    in_skipped_section: str | None = None
    in_appendix = False
    seen_numeric_chapter = False

    for it in items:
        if it.kind == "heading":
            h = headings[id(it)]
            if h.title.lower().endswith("(continued)"):
                current.skipped.append(Skipped("repeated heading", it.text, it.page))
                continue
            if h.level == 1:
                in_skipped_section = None
                if SKIP_SECTIONS.match(h.title):
                    in_skipped_section = h.title.lower()
                    current.skipped.append(Skipped(f"{h.title.lower()} section", it.text, it.page))
                    continue
                if APPENDIX_START.match(h.title):
                    in_appendix = True
                if h.number and h.number[0].isdigit():
                    seen_numeric_chapter = True
                # "A. Extended Related Work" after numbered chapters is an appendix.
                if seen_numeric_chapter and h.number and h.number.split(".")[0].isalpha():
                    in_appendix = True
                current = Chapter(h.title, h.number, in_appendix)
                chapters.append(current)
                continue
            if in_skipped_section:
                current.skipped.append(Skipped(f"{in_skipped_section} section", it.text, it.page))
                continue
            if current is opening and len(chapters) == 1 and not opening.segments and title == fallback_title:
                title = it.text
                opening.segments.append(Segment("title", it.text, [it.page] if it.page else []))
                continue
            current.segments.append(Segment("heading", h.title, [it.page] if it.page else [], h.level))
            continue

        if in_skipped_section:
            current.skipped.append(Skipped(f"{in_skipped_section} section", it.text, it.page))
            continue
        if it.kind == "skip":
            current.skipped.append(Skipped(it.reason, it.text, it.page))
            continue
        if TEMPLATE_PLACEHOLDER.search(it.text):
            current.skipped.append(Skipped("prompt template", it.text, it.page))
            continue
        if current is opening and it.kind == "text" and is_front_matter(it.text):
            current.skipped.append(Skipped("front matter", it.text, it.page))
            continue

        text, cites = strip_citations(it.text)
        current.citations_removed += cites
        if not text:
            continue
        pages = [it.page] if it.page else []

        # Join a paragraph that was split by a figure, formula or page break: the previous one
        # doesn't end a sentence and this one doesn't start one ("…the attributes" | "Φ(e) of…").
        last = current.segments[-1] if current.segments else None
        if (
            it.kind == "text"
            and last is not None
            and last.kind in ("paragraph", "list_item")  # Docling tags some dialogue as list items
            and not SENTENCE_END.search(last.text)
            and continues_sentence(text)
        ):
            last.text = f"{last.text} {text}"
            last.pages += [p for p in pages if p not in last.pages]
            continue

        current.segments.append(Segment("paragraph" if it.kind == "text" else "list_item", text, pages))

    for chapter in chapters:
        _drop_empty_headings(chapter)
        # Last: fix the source's typos, then rewrite what the voice would misread (speech.py).
        chapter.title = apply_corrections(chapter.title, corrections)
        chapter.announce = for_speech(chapter.title)
        for seg in chapter.segments:
            seg.text = for_speech(apply_corrections(seg.text, corrections))
    chapters = [c for c in chapters if c.segments]
    return BookPlan(title, chapters, author)
