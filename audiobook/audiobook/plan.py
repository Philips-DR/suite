"""DoclingDocument → BookPlan: exactly what the narrator will say, chapter by chapter.

Pure: no I/O, no models. Every element that is not spoken is recorded as `Skipped` with a reason,
so the preview can show what was left out and why.
"""

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterator, Literal

from docling_core.types.doc import DoclingDocument

from .names import title_at_heading, title_from_file_name
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
# "Chapter 1" set on its own line above the chapter's title, which Docling reads as text, not a heading.
NUMBER_WORDS = ("one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
                "sixteen|seventeen|eighteen|nineteen|twenty")
CHAPTER_LABEL = re.compile(rf"^(chapter|part|book)\s+(\d+|[ivxlc]+|{NUMBER_WORDS})$", re.IGNORECASE)
# The same label at the start of a longer heading: "Chapter 3 Spiritual Dreams and Visions", "Part I, The…".
CHAPTER_PREFIX = re.compile(rf"^(chapter|part|book)\s+(\d+|[ivxlc]+|{NUMBER_WORDS})\b[.:,]?\s*", re.IGNORECASE)
CONTENTS_HEADING = re.compile(r"^(table of )?contents$", re.IGNORECASE)
# A contents page names a chapter and, at most, a line or two about it; a chapter is pages.
CONTENTS_ENTRY_WORDS = 60


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


def place_chapter_labels(items: list[Item]) -> list[Item]:
    """"Chapter 3" on a line of its own starts chapter 3, as a heading, at the top of its page.

    Docling reads such a label as text, and does not keep it in its place: in one book it came after the
    chapter's title, at the foot of the chapter's first page, or with no title at all. Read where it lands, it
    was a sentence, and the chapter's first page went to the chapter before. What holds is the page it is on.
    The unnumbered title heading that follows it on the same page joins it ("Chapter 1 GOD'S PURPOSE…"); one
    on the next page, or a numbered one ("1.1 Background"), is the chapter's first section. It does not move
    back past another chapter's start. A label Docling read as a heading is in its place and is left there:
    moving one would take the end of the chapter before when two chapters share a page."""
    placed: list[Item] = []
    i = 0
    while i < len(items):
        it = items[i]
        if it.kind != "text" or not CHAPTER_LABEL.match(it.text):
            placed.append(it)
            i += 1
            continue
        nxt = items[i + 1] if i + 1 < len(items) else None
        text = it.text
        if nxt is not None and nxt.kind == "heading" and nxt.page == it.page and parse_heading(nxt.text).level is None:
            text, i = f"{it.text} {nxt.text}", i + 1
        at = len(placed)
        while (it.page is not None and at > 0 and placed[at - 1].page == it.page
               and not (placed[at - 1].kind == "heading" and parse_heading(placed[at - 1].text).level == 1)):
            at -= 1
        placed.insert(at, Item("heading", text, it.page))
        i += 1
    return placed


def _key(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.casefold()))


def _identity(text: str) -> str:
    """What makes two headings the same chapter: its label when it has one ("chapter 3", for the contents
    page's "Chapter 3 Spiritual Dreams…" and the chapter's own "Chapter 3"), else its words."""
    m = CHAPTER_PREFIX.match(text)
    return _key(m.group().rstrip(".:, ")) if m else _key(text)


def _without_label(text: str) -> str:
    return CHAPTER_PREFIX.sub("", text, count=1)


def _until(items: list[Item], index: int, stop) -> list[Item]:
    """What follows the item at `index`, up to the first item `stop` is true of."""
    under = []
    for it in items[index + 1:]:
        if stop(it):
            break
        under.append(it)
    return under


def find_contents(items: list[Item], headings: dict[int, Heading]) -> tuple[set[int], dict[str, str]]:
    """The book's own contents page, which Docling can read as headings ("Chapter 1 God's Purpose for Dreams
    and Visions", then a line about it) rather than as a table of contents. Read as chapters, each was a
    chapter of one sentence, and the book's real text all went into the last of them.

    An entry is a top-level heading that is the same chapter as a later one (`_identity`), with at most a line
    or two before the next top-level heading; a page of them is two or more. Counting to the next top-level
    heading, not the next heading, is what keeps a real chapter that opens straight onto a section ("Chapter
    1", "1.1 Background") from being taken for one when a book numbers its chapters again in each part.
    Returns the ids of the items to leave out, and each chapter's name as the contents page writes it ("God's
    Purpose…", where the chapter's own page is in capitals, or has no title at all). A "Contents" heading and
    what is under it is left out too."""
    def is_top(it: Item) -> bool:
        return it.kind == "heading" and headings[id(it)].level == 1

    top = [i for i, it in enumerate(items) if is_top(it)]
    entries: list[tuple[int, list[Item]]] = []
    for n, i in enumerate(top):
        same = _identity(items[i].text)
        if not any(_identity(items[j].text) == same for j in top[n + 1:]):
            continue
        under = _until(items, i, is_top)
        if sum(len(it.text.split()) for it in under if it.kind in ("text", "list_item")) <= CONTENTS_ENTRY_WORDS:
            entries.append((i, under))
    skip: set[int] = set()
    names: dict[str, str] = {}
    if len(entries) >= 2:
        for i, under in entries:
            skip |= {id(items[i])} | {id(it) for it in under}
            names.setdefault(_identity(items[i].text), items[i].text)
    for i, it in enumerate(items):
        if it.kind == "heading" and CONTENTS_HEADING.match(it.text):
            skip |= {id(it)} | {id(x) for x in _until(items, i, lambda x: x.kind == "heading")}
    return skip, names


# ---------------------------------------------------------------------------------------------
# Step 3: text clean-up

YEAR = r"(?:19|20)\d{2}[a-z]?"
# (Qin et al., 2024; Sumers et al., 2023) — must start with a capital and end in a year.
PAREN_CITATION = re.compile(rf"\s*\((?:(?:see|e\.g\.,?|cf\.)\s+)?[A-Z][^()]*?,?\s?{YEAR}(?:\s*[;,]\s*[^();]*?{YEAR})*\)")
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


def choose_title(file_name: str, title: str | None, author: str | None, front: list[str]) -> tuple[str | None, str | None]:
    """The book's title and author: the PDF's own; else its file name's, cut where a heading on the title page
    (`front`: the headings before the first chapter) ends; else the file name's when it is two words or more.
    None for the title when none of them names one, and the book's first heading is then its title, as a
    paper's is: a file called "paper" or "2609.09153v1" says less than the heading does."""
    named, named_author = title_from_file_name(file_name)
    if not title and named:
        title = title_at_heading(named, front) or (named if len(re.findall(r"\w+", named)) >= 2 else None)
    return title, author or named_author


def build_plan(
    doc: DoclingDocument, file_name: str, title: str | None = None, author: str | None = None,
    corrections: list[tuple[str, str]] = (),
) -> BookPlan:
    """`file_name` is the PDF's, without .pdf; `title` and `author` its own metadata, when it has them."""
    items = place_chapter_labels(list(walk(doc)))
    headings = {id(it): parse_heading(it.text) for it in items if it.kind == "heading"}

    # If nothing looks like a top-level heading, every heading starts a chapter.
    if not any(h.level == 1 for h in headings.values()):
        for h in headings.values():
            h.level = 1
    contents, contents_names = find_contents(items, headings)

    first_chapter = next((i for i, it in enumerate(items) if it.kind == "heading" and headings[id(it)].level == 1), len(items))
    front = [it.text for it in items[:first_chapter] if it.kind == "heading"]
    title, author = choose_title(file_name, title, author, front)
    title_from_first_heading = title is None
    opening = Chapter("Opening")
    chapters = [opening]
    current = opening
    in_skipped_section: str | None = None
    in_appendix = False
    seen_numeric_chapter = False

    for it in items:
        if id(it) in contents:
            current.skipped.append(Skipped("table of contents", it.text, it.page))
            continue
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
                # The contents page's name for it, where it has one: "God's Purpose…", not "GOD'S PURPOSE…".
                named = contents_names.get(_identity(it.text))
                current = Chapter(parse_heading(named).title if named else h.title, h.number, in_appendix)
                chapters.append(current)
                continue
            if in_skipped_section:
                current.skipped.append(Skipped(f"{in_skipped_section} section", it.text, it.page))
                continue
            # A chapter's own title page under its label: "Chapter 16 A Charge to Dreamers", then "A CHARGE TO DREAMERS".
            if current is not opening and not current.segments and _key(h.title) == _key(_without_label(current.title)):
                current.skipped.append(Skipped("repeated heading", it.text, it.page))
                continue
            if title_from_first_heading and current is opening and len(chapters) == 1 and not opening.segments:
                title_from_first_heading = False
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
    return BookPlan(title or file_name, chapters, author)
