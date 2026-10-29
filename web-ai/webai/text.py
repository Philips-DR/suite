"""A web page as the text a person would read, and the links they could click. No model, no summary.

Standard library only. The aim is the page as a reader sees it, which matters for a second reason besides
tidiness: a page is written by someone who may want to speak to the model reading it, and the cheapest way is
text a person cannot see -- a hidden element, a zero-width or "tag" character run, a script. None of that is
the page a reader sees, so none of it is returned. This catches what is hidden in the markup itself
(`hidden`, `aria-hidden="true"`, an inline `display:none` or `visibility:hidden`) and invisible characters.
It cannot catch text hidden by a stylesheet (white on white, positioned off the screen): that needs a
browser's layout, and the tool's description tells the model the text is untrusted either way.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin, urlsplit

MAX_LINKS = 300
MAX_LINK_TEXT = 200
MAX_TITLE = 300

# Never shown to a reader, or not text: their content is dropped.
SKIPPED = {"script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "canvas", "math"}
# No end tag, so they never open anything.
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
# A new line, as a reader sees it.
BLOCKS = {
    "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
    "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
    "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "ul", "br",
}
CELLS = {"td", "th"}

_HIDDEN_STYLE = re.compile(r"(?:display\s*:\s*none|visibility\s*:\s*hidden)", re.IGNORECASE)
_BLANKS = re.compile(r"[ \t\r\f\v ]+")
_SOURCE_WHITESPACE = re.compile(r"[ \t\r\n\f\v]+")
LINK_SCHEMES = {"http", "https", "mailto"}


def clean(text: str) -> str:
    """Remove what a reader cannot see: format characters (zero-width spaces and joiners, bidirectional
    overrides, the Unicode "tag" block) and control characters other than a new line or tab."""
    return "".join(
        c for c in text
        if c in "\n\t" or unicodedata.category(c) not in ("Cf", "Cc")
    )


@dataclass
class PageText:
    title: str = ""
    text: str = ""
    links: list[dict[str, str]] = field(default_factory=list)
    scripts: int = 0          # how many <script> the page has: a page of scripts and no words builds itself in a browser


class _Extractor(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.out: list[str] = []
        self.title_parts: list[str] = []
        self.links: list[dict[str, str]] = []
        self.seen: set[tuple[str, str]] = set()
        self.scripts = 0
        self._stack: list[tuple[str, bool]] = []   # (tag, hides what is inside it)
        self._hidden = 0
        self._anchor: tuple[str, list[str]] | None = None
        self._base_set = False

    # -- the open elements ------------------------------------------------------------------------

    @staticmethod
    def _hides(tag: str, attrs: dict[str, str | None]) -> bool:
        return (tag in SKIPPED or "hidden" in attrs
                or (attrs.get("aria-hidden") or "").strip().lower() == "true"
                or bool(_HIDDEN_STYLE.search(attrs.get("style") or "")))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag == "script":
            self.scripts += 1
        if tag == "base" and not self._base_set and a.get("href"):
            self.base, self._base_set = urljoin(self.base, a["href"].strip()), True
        if tag in VOID:
            if not self._hidden and tag in BLOCKS:
                self.out.append("\n")
            return
        hides = self._hides(tag, a)
        self._stack.append((tag, hides))
        self._hidden += hides
        if self._hidden:
            return
        if tag in BLOCKS:
            self.out.append("\n- " if tag == "li" else "\n")
        elif tag in CELLS:
            self.out.append(" ")
        elif tag == "a" and a.get("href") and self._anchor is None:
            self._anchor = (a["href"], [])

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # `<div/>` is not an empty element in HTML, but `<br/>` is: treat only the void ones as closed.
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in VOID or not any(name == tag for name, _ in self._stack):
            return
        # Close it and anything left open inside it (<p> and <li> are often never closed).
        while self._stack:
            name, hides = self._stack.pop()
            self._hidden -= hides
            if name == "a" and self._anchor is not None:
                self._finish_anchor()
            if not self._hidden and name in BLOCKS:
                self.out.append("\n")
            if name == tag:
                break

    def handle_data(self, data: str) -> None:
        if self._hidden:
            return
        if any(name == "title" for name, _ in self._stack):
            self.title_parts.append(data)
            return
        # A line break in the HTML source is only whitespace, as it is to a browser: a hard-wrapped paragraph is
        # one line. Inside <pre> it is a line break.
        if not any(name == "pre" for name, _ in self._stack):
            data = _SOURCE_WHITESPACE.sub(" ", data)
        self.out.append(data)
        if self._anchor is not None:
            self._anchor[1].append(data)

    # -- links ------------------------------------------------------------------------------------

    def _finish_anchor(self) -> None:
        href, words = self._anchor  # type: ignore[misc]
        self._anchor = None
        href = href.strip()
        if not href or href.startswith("#"):
            return
        url = urljoin(self.base, href)
        scheme = urlsplit(url).scheme
        if scheme not in LINK_SCHEMES:
            return
        if scheme != "mailto":
            url = urldefrag(url)[0]
        label = _BLANKS.sub(" ", clean("".join(words)).replace("\n", " ")).strip()[:MAX_LINK_TEXT]
        if (url, label) in self.seen or len(self.links) >= MAX_LINKS:
            return
        self.seen.add((url, label))
        self.links.append({"text": label, "url": url})


def html_to_text(html: str, base_url: str = "") -> PageText:
    """The text of an HTML page, one line per block, and its links as absolute addresses."""
    parser = _Extractor(base_url)
    parser.feed(html)
    parser.close()
    lines: list[str] = []
    for raw in clean("".join(parser.out)).split("\n"):
        line = _BLANKS.sub(" ", raw).strip()
        if line or (lines and lines[-1]):   # at most one blank line in a row, none at the start
            lines.append(line)
    title = _BLANKS.sub(" ", clean("".join(parser.title_parts)).replace("\n", " ")).strip()[:MAX_TITLE]
    return PageText(title=title, text="\n".join(lines).strip(), links=parser.links, scripts=parser.scripts)


def plain_text(text: str) -> str:
    """Text that was never markup: line endings made alike, what a reader cannot see removed."""
    return clean(text.replace("\r\n", "\n").replace("\r", "\n")).strip()


_CHARSET = re.compile(r"charset\s*=\s*[\"']?([\w.:-]+)", re.IGNORECASE)
_META_CHARSET = re.compile(rb"<meta[^>]+charset\s*=\s*[\"']?([\w.:-]+)", re.IGNORECASE)


def decode(body: bytes, content_type: str = "") -> str:
    """Bytes to text, in the character set the response names, else the page's own <meta>, else UTF-8.
    A character that does not decode is replaced, never an error: a page with one bad byte is still a page."""
    named = _CHARSET.search(content_type)
    if named:
        charset = named.group(1)
    else:
        meta = _META_CHARSET.search(body[:2048])
        charset = meta.group(1).decode("ascii", "replace") if meta else "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")
