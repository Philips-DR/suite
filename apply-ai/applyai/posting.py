"""Read a job posting into a list of requirements, none of them dropped.

The point of doing this in code rather than leaving it to a model's reading is completeness: a model
summarising a posting quietly skips the line that does not fit its draft, and the gap it skipped is the
one the applicant most needs to hear about. Here every bullet under a requirements or duties heading
becomes an item with an id, so the next step can say, for each one, what the material shows -- or that
it shows nothing.

A posting is semi-structured prose, not a format: headings in several styles, bullets in several
glyphs, sentences wrapped by a PDF. This reads the common shapes and says what it skipped, rather than
guessing at the rest. It reads English only; a bilingual posting's second language is dropped and
counted, and a posting that is mostly in another language is refused with a reason.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from applyai.sources import plain
from applyai.text import sentences, tokens

REQUIRED, PREFERRED, DUTY = "required", "preferred", "duty"

_DUTY_HEADINGS = ("responsib", "dutie", "what you will do", "what you'll do", "what you’ll do",
                  "scope of work", "key intervention", "the role", "your role", "job description", "tasks")
_REQUIREMENT_HEADINGS = ("qualif", "requirement", "criteria", "competenc", "skill", "experience", "education",
                         "essential", "desirable", "preferred", "looking for", "you bring", "who you are",
                         "you have", "profile", "language", "eligib", "minimum", "must have", "what we need")
_PREFERRED_CUES = re.compile(
    r"\b(plus|desirable|preferred|advantage|asset|nice to have|highly valued|would be valued|bonus|an added)\b", re.I)

_BULLET = re.compile(r"^\s*(?:[-*+•●▪◦·]|\d+[.)])\s+")
_CONNECTORS = {"of", "and", "the", "for", "to", "a", "in", "on", "or", "at", "with", "your", "you", "we", "will"}

# Words that mark a line as French rather than English, and the reverse. A bilingual posting repeats
# itself in the second language; an English-only reader would report every repeated line as unmatched.
_FRENCH = frozenset("le la les des du de et en au aux une un est sont dans avec pour par sur ou qui que ce "
                    "ses leurs nous vous il elle être avoir sera seront comprendront".split())
_ENGLISH = frozenset("the and of to in for with is are will be have has an as on at by or that this "
                     "your our you we their its from".split())


@dataclass
class Requirement:
    id: int
    text: str
    section: str
    kind: str


@dataclass
class Reading:
    requirements: list[Requirement] = field(default_factory=list)
    read: list[str] = field(default_factory=list)       # headings whose lines became requirements
    skipped: list[str] = field(default_factory=list)    # headings that were left alone, and why
    notes: list[str] = field(default_factory=list)
    header: dict[str, str] = field(default_factory=dict)


def looks_french(text: str) -> bool:
    words = [w.lower() for w in tokens(text)]
    if len(words) < 4:
        return False
    return sum(w in _FRENCH for w in words) > sum(w in _ENGLISH for w in words)


def _is_title_case(line: str) -> bool:
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'’/&-]*", line)]
    if not words:
        return False
    significant = [w for w in words if w.lower() not in _CONNECTORS]
    if not significant:
        return False
    # "Position responsibilities" is a heading with one lowercase word; a longer line needs most of its words capitalised.
    return words[0][0].isupper() and (len(significant) <= 3 or sum(w[0].isupper() for w in significant) / len(significant) >= 0.6)


def _is_heading(line: str, next_line: str | None) -> bool:
    text = line.strip()
    if not text or _BULLET.match(text) or len(text.split()) > 9 or text.endswith((".", ";", ",")):
        return False
    words = len(text.split())
    if text.endswith(":"):
        # "Education:" is a heading; "...will include the following key interventions:" is a sentence
        # that happens to end in a colon.
        return words <= 4 or _is_title_case(text)
    if re.search(r":\s+\S", text):  # "Grade: EC2" is a field, not a heading
        return False
    # A short title-cased line with a break after it: a blank line, a bullet, or a heading of its own
    # ("Qualifications/Selection Criteria" sits directly above "Education:" in one real posting).
    if words > 6 or not _is_title_case(text):
        return False
    following = (next_line or "").strip()
    if not following or _BULLET.match(next_line or "") or (following.endswith(":") and len(following.split()) <= 6):
        return True
    # No break after it, as a PDF's layout often leaves it ("Position responsibilities" directly above
    # its first sentence): a heading only when it is one this reader knows by name.
    return _classify(text) != "skip"


# Headings that are never requirements, even as a subheading inside a section that is: the World Bank's
# "WBG Culture Attributes:" sits right under its Selection Criteria and is not one.
_SKIP_HEADINGS = ("about", "who we are", "benefit", "terms and conditions", "how to apply", "equal opportunit",
                  "culture", "note", "purpose", "overview", "closing date", "salary")


_FRENCH_HEADING = re.compile(r"[éèêàçùôîâû]|\b(?:critères|principales|langues|termes|comment|objectif|propos)\b", re.I)


def _classify(heading: str) -> str:
    h = heading.lower().rstrip(":").strip()
    if _FRENCH_HEADING.search(h):
        return "explicit-skip"  # the French half of a bilingual posting: its lines are dropped as French
    if any(k in h for k in _SKIP_HEADINGS):
        return "explicit-skip"
    if any(k in h for k in _DUTY_HEADINGS):
        return DUTY
    if any(k in h for k in _REQUIREMENT_HEADINGS):
        return REQUIRED
    return "skip"


def _blocks(lines: list[str]) -> list[tuple[str, str]]:
    """(kind, text) in order: kind is "heading", "bullet" or "para". Wrapped lines are joined."""
    out: list[tuple[str, str]] = []
    current: tuple[str, list[str]] | None = None

    def flush() -> None:
        nonlocal current
        if current:
            out.append((current[0], " ".join(current[1])))
        current = None

    for i, raw in enumerate(lines):
        line = raw.rstrip()
        following = lines[i + 1] if i + 1 < len(lines) else None
        if not line.strip():
            flush()
        elif _BULLET.match(line):
            flush()
            current = ("bullet", [_BULLET.sub("", line).strip()])
        elif _is_heading(line, following) and (current is None or current[1][-1].rstrip().endswith((".", "!", "?", ";", ":"))):
            # A heading may follow a finished block without a blank line between (a PDF's layout often
            # drops it), but never interrupts a sentence that is still wrapping.
            flush()
            out.append(("heading", line.strip()))
        elif current is None:
            current = ("para", [line.strip()])
        else:
            current[1].append(line.strip())
    flush()
    return out


def _clauses(item: str) -> list[str]:
    """Split one bullet at semicolons when each side stands alone: "a Master's degree...; a PhD is a plus"
    is a requirement and a bonus, and "English...; working knowledge of French is highly desirable" is a
    requirement and a preference. Kept whole when a side is too short to be a requirement of its own."""
    parts = [p.strip(" ;") for p in item.split(";")]
    parts = [p for p in parts if p]
    if len(parts) > 1 and all(len(p.split()) >= 3 for p in parts):
        return [p[0].upper() + p[1:] for p in parts]
    return [item.strip(" ;")]


_FIELD = re.compile(r"^\s*([A-Za-z][A-Za-z #()/.'’-]{1,40}?):\s{1,}(\S.*)$")


def read_posting(posting: str) -> Reading:
    reading = Reading()
    lines = posting.replace("\r", "").splitlines()

    # The header lines of an application page ("Required Language(s): English") carry requirements too.
    for line in lines[:25]:
        m = _FIELD.match(line)
        if m:
            reading.header[m.group(1).strip().lower()] = m.group(2).strip()

    prose = [b for b in _blocks(lines) if b[0] != "para" or not _FIELD.match(b[1])]
    long_blocks = [text for _, text in prose if len(text.split()) >= 6]
    if long_blocks and sum(looks_french(t) for t in long_blocks) / len(long_blocks) > 0.7:
        reading.notes.append("This posting appears to be in French. This check reads English only, so no "
                             "requirements were extracted; give it the English version.")
        return reading

    section, klass, subheading = "", "skip", False
    dropped_french = 0
    french_headings = 0
    for kind, text in prose:
        if kind == "heading":
            heading = text.rstrip(":").strip()
            new = _classify(heading)
            is_sub = text.endswith(":") and klass not in ("skip", "explicit-skip")
            if new == "skip" and is_sub:
                new = klass  # an unfamiliar subheading inside a section belongs to that section
            if new == "explicit-skip":
                new = "skip"
            if is_sub and new == klass and section:
                subheading = True
            else:
                subheading = False
                section = heading
            klass = new
            label = heading if not subheading else f"{section} / {heading}"
            if new == "skip":
                if _FRENCH_HEADING.search(heading.lower()):
                    french_headings += 1
                else:
                    reading.skipped.append(heading)
            elif label not in reading.read:
                reading.read.append(label)
            # a section named "Desirable" or "Preferred" makes everything under it preferred
            continue
        if klass == "skip":
            continue
        cleaned = plain(text)
        if len(cleaned.split()) < 3 or cleaned.endswith(":") or not re.search(r"[A-Za-z]", cleaned):
            continue  # a lead-in ("...the following key interventions:"), a stray full stop
        parts = [cleaned] if kind == "bullet" else [s for s in sentences(cleaned) if len(s.split()) >= 4]
        for part in parts:
            if looks_french(part):
                dropped_french += 1
                continue
            for clause in _clauses(part):
                item_kind = DUTY if klass == DUTY else (
                    PREFERRED if _PREFERRED_CUES.search(clause) or "desirable" in section.lower() or "preferred" in section.lower()
                    else REQUIRED)
                reading.requirements.append(Requirement(len(reading.requirements) + 1, clause, section, item_kind))

    # "Required Language(s): English" / "Preferred Language(s): French" in the header, as requirements.
    for key, value in reading.header.items():
        if "language" in key:
            item_kind = PREFERRED if "preferred" in key else REQUIRED
            reading.requirements.append(
                Requirement(len(reading.requirements) + 1, f"{'Preferred' if item_kind == PREFERRED else 'Required'} language: {value}",
                            "Header", item_kind))
    if dropped_french or french_headings:
        reading.notes.append("The posting repeats itself in French; the French half was skipped "
                             f"({french_headings} headings, {dropped_french} further lines).")
    if not reading.requirements:
        reading.notes.append("No requirements or duties were found: no heading such as Requirements, Qualifications, "
                             "Selection Criteria or Responsibilities was recognised. Paste the posting with its headings.")
    return reading
