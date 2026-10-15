"""The user's own material, as lines a check can point at.

A check that says "not in your material" is only as honest as what it was given, so this is the one
place that decides what counts as material: files the person already has (a CV, notes), read from
disk by this tool -- never retyped by a model, which would let a paraphrase stand in for the source --
and short facts the person has confirmed in conversation.

Reads are confined to the folders the caller names (`APPLY_AI_ROOTS`, injected by tools.yaml): a model
is handed paths by an upload and has no business reading anything else on the machine.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from applyai.text import sentences

CONFIRMED = "confirmed by you"
# The assistant drops this file beside every draft it writes (assistant/documents.py, DRAFT_MARKER). A
# convention in a filename, not an import. A draft is a model's words, not the user's: if its claims counted
# as material, a claim made once would be "supported" by itself the next time.
DRAFT_MARKER = ".draft"
MAX_BYTES = 1_000_000
SUFFIXES = (".md", ".markdown", ".txt")


class SourceError(ValueError):
    """A source that cannot be read, said in words a person can act on."""


@dataclass(frozen=True)
class Line:
    source: str
    text: str


_BULLET = re.compile(r"^\s*(?:[-*+•●▪◦·]|\d+[.)])\s+")
_HEADING = re.compile(r"^\s*#{1,6}\s+")
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")


def plain(text: str) -> str:
    """Markdown syntax out, words in: bold, italics, code, link targets, table pipes, trailing breaks."""
    text = _LINK.sub(r"\1", text)
    text = re.sub(r"(\*\*|__|\*|_|`)(?=\S)(.+?)(?<=\S)\1", r"\2", text)
    text = text.replace("\\", " ").replace("|", " ")
    return re.sub(r"\s+", " ", text).strip()


def units(markdown: str) -> list[str]:
    """Headings, bullets and paragraphs of a document, soft-wrapped lines joined, one string each."""
    blocks: list[str] = []
    current: list[str] = []

    def flush() -> None:
        if current:
            blocks.append(" ".join(current))
            current.clear()

    for raw in _COMMENT.sub("", markdown).splitlines():
        if not raw.strip():
            flush()
        elif _HEADING.match(raw):
            flush()
            blocks.append(_HEADING.sub("", raw))
        elif _BULLET.match(raw):
            flush()
            current.append(_BULLET.sub("", raw))
        elif re.fullmatch(r"\s*[-*_]{3,}\s*", raw):
            flush()
        else:
            current.append(raw.strip())
    flush()

    out: list[str] = []
    for block in blocks:
        text = plain(block)
        out.extend(sentences(text) if len(text) > 160 else [text])
    return [u for u in out if u]


def read_source(path: str, roots: list[Path] | None = None) -> tuple[str, list[Line]]:
    """One file's units as lines, named for the file. `roots` of None means unrestricted (a person at
    a terminal); a list means the path must resolve inside one of them."""
    target = Path(path).expanduser().resolve()
    if roots is not None and not any(target.is_relative_to(r.resolve()) for r in roots):
        raise SourceError("only documents in the uploads folder can be read")
    if target.suffix.lower() not in SUFFIXES or not target.is_file():
        raise SourceError(f"no markdown or text file at {path}")
    if (target.parent / DRAFT_MARKER).exists():
        raise SourceError(
            f"{target.name} is a draft the assistant wrote, not the user's own material, so it cannot be a "
            "source: a claim a draft made would then count as supported by itself. Use the documents the user "
            "uploaded, and pass anything the user has confirmed as `facts`.")
    if target.stat().st_size > MAX_BYTES:
        raise SourceError(f"{target.name} is larger than {MAX_BYTES // 1000} KB")
    text = target.read_text(encoding="utf-8", errors="replace")
    return target.name, [Line(target.name, u) for u in units(text)]


def confirmed_lines(facts: list[str]) -> list[Line]:
    return [Line(CONFIRMED, plain(f)) for f in facts if plain(f)]


def gather(paths: list[str], facts: list[str], roots: list[Path] | None = None) -> list[Line]:
    """Everything a draft may be checked against: the named files, then the confirmed facts."""
    if not paths and not facts:
        raise SourceError("no source material was given: name at least one file, or pass confirmed facts")
    lines: list[Line] = []
    for path in paths:
        lines.extend(read_source(path, roots)[1])
    lines.extend(confirmed_lines(facts))
    if not lines:
        raise SourceError("the source files hold no text")
    return lines


def roots_from_environment() -> list[Path]:
    """`APPLY_AI_ROOTS`, os.pathsep-separated; the working folder if unset. Front doors only."""
    configured = os.environ.get("APPLY_AI_ROOTS", "")
    folders = [Path(p).expanduser() for p in configured.split(os.pathsep) if p.strip()]
    return folders or [Path.cwd()]
