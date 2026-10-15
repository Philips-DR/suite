"""Set each requirement of a posting against what the user's own material shows.

Two kinds of finding, and they are kept apart because they are not equally sure:

  * HARD checks, which are facts and can be wrong in only one direction: the posting asks for a master's
    degree and nothing in the material mentions a degree above a bachelor's; it names Stata and the word
    is nowhere; it asks for French and French is nowhere. These are exact, and they are the gaps an
    applicant most needs to hear about before a document claims otherwise.
  * LEXICAL tracing for everything else: which lines of the material share the requirement's distinctive
    words, and which of those words appear nowhere in the material at all. It points, it does not
    judge -- "partly" means "read these lines", and the model and the person do the reading.

Nothing here decides what to say. It makes sure no requirement is skipped, and that "the material shows
nothing for this" is a line in a list rather than something a draft quietly avoids mentioning.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date

from applyai.posting import PREFERRED, Requirement
from applyai.sources import CONFIRMED, Line
from applyai.text import content_stems, stem, tokens
from applyai.vocabulary import (
    DEGREE_LEVELS,
    DEGREE_NAMES,
    TOOLS,
    TRAIT_WORDS,
    degree_levels,
    languages_named,
    tool_in,
    tools_named,
)

GAP, CHECK, NOT_FOUND, PARTLY, SUPPORTED = "gap", "check", "not_found", "partly", "supported"
TRAIT = "trait"
TRAIT_SHARE = 0.3
EVIDENCE_MIN = 0.25
MAX_MISSING = 12
LINE_CHARS = 230

_MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
_SPAN = re.compile(
    r"(?:(?P<sm>[A-Za-z]{3,9})\.?\s+)?(?P<sy>(?:19|20)\d{2})\s*[–—-]\s*"
    r"(?:(?P<present>Present|Current|Now|Ongoing|Today)|(?:(?P<em>[A-Za-z]{3,9})\.?\s+)?(?P<ey>(?:19|20)\d{2}))", re.I)
_YEARS = re.compile(r"(\d+)(?:\s*[-–to]+\s*(\d+))?\s*\+?\s*years?", re.I)


@dataclass
class Check:
    type: str                      # degree | language | tool | years
    needs: str
    found: str
    met: bool | None               # None: a person has to decide (years)
    note: str = ""
    evidence: list[dict] = field(default_factory=list)


@dataclass
class Matched:
    requirement: Requirement
    status: str
    checks: list[Check]
    evidence: list[dict]
    words_not_found: list[str]
    coverage: float


def _clip(text: str) -> str:
    return text if len(text) <= LINE_CHARS else text[: LINE_CHARS - 1].rstrip() + "…"


def _cite(line: Line, **extra: object) -> dict:
    return {"source": line.source, "line": _clip(line.text), **extra}


def _month(name: str | None) -> int | None:
    return _MONTHS.get((name or "")[:3].lower())


def date_spans(lines: list[Line], today: date) -> list[tuple[Line, Line | None, str]]:
    """Dated roles in the material, each with the line before it (usually the role's name) and how long
    it ran, worked out from the dates as written. "Present" means today, which is why `today` is passed in."""
    out: list[tuple[Line, Line | None, str]] = []
    for i, line in enumerate(lines):
        m = _SPAN.search(line.text)
        if not m:
            continue
        start_year, start_month = int(m["sy"]), _month(m["sm"])
        if m["present"]:
            end_year, end_month = today.year, today.month
        else:
            end_year, end_month = int(m["ey"]), _month(m["em"])
        if start_month and end_month:
            months = (end_year - start_year) * 12 + (end_month - start_month)
            years, rest = divmod(max(months, 0), 12)
            how = f"about {years} year{'s' if years != 1 else ''}" + (f" {rest} month{'s' if rest != 1 else ''}" if rest else "")
        else:
            years = max(end_year - start_year, 0)
            how = f"about {years} year{'s' if years != 1 else ''} (months not given)"
        out.append((line, lines[i - 1] if i > 0 and lines[i - 1].source == line.source else None, how))
    return out


def _degree_check(req: Requirement, lines: list[Line]) -> Check | None:
    wanted = degree_levels(req.text)
    if not wanted:
        return None
    ranked = sorted(wanted, key=DEGREE_LEVELS.index)
    need = ranked[0] if (len(ranked) > 1 and re.search(r"\bor\b", req.text)) else ranked[-1]
    have, have_line = -1, None
    for line in lines:
        for level in degree_levels(line.text):
            if DEGREE_LEVELS.index(level) > have:
                have, have_line = DEGREE_LEVELS.index(level), line
    notes = []
    if re.search(r"\bor equivalent\b", req.text, re.I):
        notes.append("the posting accepts an equivalent")
    if re.search(r"\bongoing\b|\bcurrently (?:enrolled|pursuing)\b|\bcompleted or\b", req.text, re.I):
        notes.append("the posting accepts a degree still in progress")
    met = have >= DEGREE_LEVELS.index(need)
    found = (f"your material shows {DEGREE_NAMES[DEGREE_LEVELS[have]]}: {_clip(have_line.text)}" if have_line
             else "your material mentions no degree")
    return Check("degree", f"{DEGREE_NAMES[need]}", found, met, "; ".join(notes),
                 [_cite(have_line)] if have_line else [])


def _language_checks(req: Requirement, lines: list[Line]) -> list[Check]:
    out = []
    for name in languages_named(req.text):
        if name == "English":
            out.append(Check("language", "English", "your documents are written in English; "
                             "how well you speak it is yours to say", True))
            continue
        hit = next((ln for ln in lines if re.search(rf"\b{name}\b", ln.text, re.I)), None)
        out.append(Check("language", name, f"{name} is mentioned: {_clip(hit.text)}" if hit
                         else f"{name} is not mentioned anywhere in your material", hit is not None,
                         evidence=[_cite(hit)] if hit else []))
    return out


def _tool_groups(req: Requirement) -> list[list[str]]:
    """Tools the requirement names, with alternatives ("Stata and/or R", "Linux/Unix") grouped: having
    any one of a group meets it."""
    named = tools_named(req.text)
    groups: list[list[str]] = []
    for name in named:
        placed = False
        for group in groups:
            other = group[-1]
            between = re.search(rf"{re.escape(other)}\s*(?:/|and/or|or)\s*{re.escape(name)}", req.text)
            if between:
                group.append(name)
                placed = True
                break
        if not placed:
            groups.append([name])
    return groups


def _tool_checks(req: Requirement, lines: list[Line]) -> list[Check]:
    wanted = content_stems(req.text)
    out = []
    for group in _tool_groups(req):
        hit = None
        for name in group:
            hits = [ln for ln in lines if tool_in(ln.text, TOOLS[name])]
            # The line that shares most with the requirement, then the shortest: "Languages: Python, ..."
            # is better evidence than a project header that happens to carry a link to GitHub.
            hit = min(hits, key=lambda ln: (-len(wanted & content_stems(ln.text)), len(ln.text)), default=None)
            if hit:
                break
        label = " or ".join(group)
        out.append(Check("tool", label, f"found: {_clip(hit.text)}" if hit else f"{label} is not mentioned anywhere in your material",
                         hit is not None, evidence=[_cite(hit)] if hit else []))
    return out


def _years_check(req: Requirement, lines: list[Line], today: date) -> Check | None:
    m = _YEARS.search(req.text)
    if not m:
        return None
    needs = f"{m.group(1)}–{m.group(2)} years" if m.group(2) else f"{m.group(1)} years"
    spans = date_spans(lines, today)
    if not spans:
        return Check("years", needs, "no dated roles were found in your material", None)
    detail = "; ".join(f"{(role.text if role else 'a role')}, {line.text.split('·')[0].strip()} ({how})"
                       for line, role, how in spans[:6])
    return Check("years", needs, f"your dated roles, worked out from their dates as of {today.isoformat()}: {detail}",
                 None, "whether the requirement counts only this kind of work is for the person to say",
                 [_cite(line) for line, _, _ in spans[:3]])


def _weights(lines: list[Line], stems_of: list[set[str]]) -> dict[str, float]:
    df: dict[str, int] = {}
    for stems in stems_of:
        for s in stems:
            df[s] = df.get(s, 0) + 1
    n = len(lines)
    return {s: math.log((n + 1) / (c + 0.5)) + 1.0 for s, c in df.items()}


def match(requirements: list[Requirement], lines: list[Line], today: date | None = None) -> list[Matched]:
    today = today or date.today()
    stems_of = [content_stems(ln.text) for ln in lines]
    weights = _weights(lines, stems_of)
    everything = set().union(*stems_of) if stems_of else set()
    default_weight = max(weights.values(), default=1.0)
    results: list[Matched] = []

    for req in requirements:
        wanted = content_stems(req.text)
        total = sum(weights.get(s, default_weight) for s in wanted) or 1.0
        surface = {}
        for tok in tokens(req.text):
            surface.setdefault(stem(tok), tok)

        scored = []
        for line, stems in zip(lines, stems_of, strict=True):
            shared = wanted & stems
            if shared:
                scored.append((sum(weights[s] for s in shared) / total, line))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        best = scored[0][0] if scored else 0.0
        coverage = sum(weights.get(s, default_weight) for s in wanted & everything) / total
        evidence = [_cite(line, overlap=round(score, 2)) for score, line in scored[:2] if score >= EVIDENCE_MIN]
        missing = sorted((surface.get(s, s) for s in wanted - everything), key=str.lower)

        checks: list[Check] = []
        degree = _degree_check(req, lines)
        if degree:
            checks.append(degree)
        checks += _language_checks(req, lines)
        checks += _tool_checks(req, lines)
        years = _years_check(req, lines, today)
        if years:
            checks.append(years)

        if checks:
            # A failed hard check must not sit beside lines that merely share a word with it ("Languages:
            # Python, ..." under a request for French): the check's own evidence is the only evidence.
            evidence = [e for c in checks for e in c.evidence][:2]

        if any(c.met is False for c in checks):
            status = GAP
        elif any(c.met is None for c in checks):
            status = CHECK
        elif checks:
            status = SUPPORTED
        elif req.kind != "duty" and wanted and len({stem(w) for w in TRAIT_WORDS} & wanted) / len(wanted) >= TRAIT_SHARE:
            status = TRAIT
        elif best >= 0.5 and coverage >= 0.8:
            status = SUPPORTED
        elif coverage >= 0.5 or best >= 0.3:
            status = PARTLY
        else:
            status = NOT_FOUND
        results.append(Matched(req, status, checks, evidence, missing[:MAX_MISSING], round(coverage, 2)))
    return results


def question_for(m: Matched) -> str | None:
    """What to ask the person, in their words, for a requirement the material does not settle. One round
    of these before drafting is the point: a draft should never be where a gap is first discovered."""
    req = m.requirement
    tag = "" if req.kind != PREFERRED else " (preferred, not required)"
    for c in m.checks:
        if c.met is False and c.type == "degree":
            extra = f" ({c.note})" if c.note else ""
            return (f"The posting asks for {c.needs}{extra}{tag}; {c.found}. Do you hold one, or are you working "
                    f"towards one? If not, say so and I will not claim it.")
        if c.met is False and c.type == "language":
            return (f"The posting asks for {c.needs}{tag}, and it is not mentioned in your material. Do you read, "
                    f"write or speak it, and how well?")
        if c.met is False and c.type == "tool":
            return (f"The posting names {c.needs}{tag}, which appears nowhere in your material. Have you used it? "
                    f"For what, and how recently?")
        if c.met is None and c.type == "years":
            return (f"The posting wants {c.needs}{tag} of the work described. In your material: {c.found}. Is there "
                    f"other work that counts (a thesis, an internship, volunteering), and for how long?")
    if m.status == NOT_FOUND and req.kind != "duty":
        words = f" (nothing matches: {', '.join(m.words_not_found[:6])})" if m.words_not_found else ""
        return f"The posting asks for: “{_clip(req.text)}”{tag}{words}. Have you done this? Where, what, and with what result?"
    return None


def source_names(lines: list[Line]) -> list[str]:
    seen: list[str] = []
    for ln in lines:
        if ln.source not in seen:
            seen.append(ln.source)
    return seen


__all__ = ["match", "question_for", "Matched", "Check", "date_spans", "source_names", "CONFIRMED",
           "GAP", "CHECK", "NOT_FOUND", "PARTLY", "SUPPORTED", "TRAIT"]
