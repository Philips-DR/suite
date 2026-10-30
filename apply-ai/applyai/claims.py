"""Check a draft's claims against the user's own material, one sentence at a time.

Found by hand, tailoring a CV for a real job: a model, only trying to sound good, added "daily", "open
tool", "fed directly into harvest planning" and "most of my time" to a CV whose source said none of it. A
prompt asking it to be honest had not stopped it. What stops it is a check that does not read for meaning
at all: every figure, every word that overstates, every tool, language, credential and name in the draft
must be traceable to a line the person already wrote -- or be shown, with the nearest line, for the person
to confirm or cut.

What it can and cannot do, said plainly because the difference matters:

  * It CAN tell that "94%" is in the material and "98%" is not; that "daily" appears in no line about this;
    that "Stata" is nowhere; that a master's degree is mentioned and the material shows a bachelor's.
  * It CANNOT tell that a sentence is true. A clean result means nothing it looks for was unsupported. It
    does not prove the sentences say what the person did, and the output says so.

So the nearest source line is shown for every finding: the judgment is a person's, and this is what makes
it quick.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from applyai.sources import Line, units
from applyai.text import content_stems, negated, numbers, stem, tokens
from applyai.vocabulary import (
    ABOUT_CODE,
    CODE_HOSTS,
    COMMON_CAPITALISED,
    DEGREE_LEVELS,
    DEGREE_NAMES,
    HEDGES,
    LANGUAGES,
    PRIVACY,
    TOOLS,
    WATCH_CATEGORY,
    watch_words_in,
    degree_levels,
    languages_named,
    tool_in,
    tools_named,
)

LINE_CHARS = 230
MAX_FINDINGS = 60
MIN_UNIT_STEMS_FOR_OVERLAP = 4
WEAK_OVERLAP = 0.4
_MONTH_NAMES = frozenset("""january february march april may june july august september october november
december jan feb mar apr jun jul aug sep sept oct nov dec""".split())
_DATE_ONLY = re.compile(r"^\W*(?:\d{1,2}\s+)?[A-Za-z]{3,9}\.?\s+(?:\d{1,2},?\s+)?\d{4}\W*$")

# Order findings are shown in: the ones that overstate or invent first, names last.
KIND_ORDER = ("figure", "claim word", "public link", "unchecked", "dropped limit", "credential", "tool", "language",
              "name")
UNCHECKED = ("the draft says code is “{}”, and nothing has checked whether it is: check each address with web-ai "
             "(github_visibility for a GitHub account or repository, check_link for another) and pass every one a "
             "stranger can open as `public_links`, or [] if none is")


@dataclass
class Finding:
    unit: str
    kind: str
    token: str
    why: str
    nearest: dict | None = None
    in_posting: bool = False

    def as_dict(self) -> dict:
        out = {"kind": self.kind, "token": self.token, "in_your_draft": _clip(self.unit), "why": self.why}
        if self.nearest:
            out["nearest_line_in_your_material"] = self.nearest
        if self.in_posting:
            out["also_in_the_posting"] = True
        return out


@dataclass
class Report:
    units_checked: int
    findings: list[Finding] = field(default_factory=list)
    names: list[Finding] = field(default_factory=list)
    traced: list[dict] = field(default_factory=list)
    weak: list[dict] = field(default_factory=list)


def _clip(text: str) -> str:
    return text if len(text) <= LINE_CHARS else text[: LINE_CHARS - 1].rstrip() + "…"


class _Material:
    """The material, indexed once so every sentence of a draft is checked against the same thing."""

    def __init__(self, lines: list[Line]) -> None:
        self.lines = lines
        self.stems = [content_stems(ln.text) for ln in lines]
        self.numbers = [set(numbers(ln.text)) for ln in lines]
        self.words = [{t.lower() for t in tokens(ln.text)} | watch_words_in(ln.text) for ln in lines]
        self.text = "\n".join(ln.text for ln in lines)
        self.all_stems = set().union(*self.stems) if self.stems else set()
        self.all_words = set().union(*self.words) if self.words else set()
        self.degree = max((DEGREE_LEVELS.index(lv) for ln in lines for lv in degree_levels(ln.text)), default=-1)

    def nearest(self, unit_stems: set[str], need: str | None = None, number: str | None = None) -> dict | None:
        """The line sharing most with the sentence, optionally one that holds a given word or figure."""
        best, best_score = None, 0
        for i, line in enumerate(self.lines):
            if need is not None and need not in self.words[i]:
                continue
            if number is not None and number not in self.numbers[i]:
                continue
            score = len(unit_stems & self.stems[i])
            if score > best_score:
                best, best_score = line, score
        if best is None and (need is not None or number is not None):
            best = next((ln for i, ln in enumerate(self.lines)
                         if (need is None or need in self.words[i]) and (number is None or number in self.numbers[i])), None)
        return {"source": best.source, "line": _clip(best.text)} if best else None

    def context(self, i: int) -> set[str]:
        """A short line's own stems plus those of the line above it, from the same file.

        A figure is usually in a lead line ("Accra, Ghana · CGPA 3.63", "Nov 2023 – Present") whose subject
        is the heading above it. Only SHORT lines borrow, and only from above: a bullet must not take a
        neighbouring bullet's subject, or any figure would be "supported" by the next sentence over."""
        stems = set(self.stems[i])
        if i > 0 and self.lines[i - 1].source == self.lines[i].source and len(tokens(self.lines[i].text)) <= 8:
            stems |= self.stems[i - 1]
        return stems

    def line_support(self, unit_stems: set[str], word: str | None = None, number: str | None = None) -> bool:
        """Is there a line that holds the word or figure AND is about the same thing as the sentence?

        Presence anywhere is not support: "open" is in a CV that says "open to remote", and "94" is in a
        line about palm trees, not banana trees. The word must sit in a line that shares the sentence's
        other distinctive words (two of them, or one when the sentence is short).
        """
        others = unit_stems - ({word} if word else set())
        need = 2 if len(others) > 3 else 1
        for i, line in enumerate(self.lines):
            if word is not None and (word not in self.words[i] or negated(line.text, word)):
                continue
            if number is not None and number not in self.numbers[i]:
                continue
            # A figure may lean on the neighbouring lines for its subject; a word may not ("open" sits in
            # "open to remote", and must not borrow the line above to look like it is about a tool).
            have = self.context(i) if number is not None else self.stems[i]
            if len(others & have) >= need:
                return True
        return False


def _is_name(token: str, first: bool) -> bool:
    if token.lower() in COMMON_CAPITALISED or token.lower() in _MONTH_NAMES or len(token) < 2:
        return False
    if token.isupper() and len(token) >= 2 and token.isalpha():
        return True                       # an acronym, wherever it stands
    if re.search(r"[a-z][A-Z]", token):
        return True                       # CamelCase: AgDataHub, PyTorch
    return token[0].isupper() and not first


_HEDGE = [re.compile(h, re.I) for h in HEDGES]
CARRIED = 0.6          # how much of a source sentence's other words a draft sentence must keep to count as it


def dropped_limits(draft_units: list[str], material: _Material) -> list[Finding]:
    """A source sentence that carries a limit, kept in the draft without it.

    Found live on the first real run of this check: asked to fit a CV on two pages the model cut "our cloud
    engineer provisions and operates the underlying clusters" and "(application/producer-consumer layer)" --
    the very qualifiers that made the CV honest about Kafka and Redis -- and the draft read as claiming
    more than the material did. Nothing was added, so nothing added was flagged.
    """
    findings: list[Finding] = []
    unit_stems = [(u, content_stems(u), u.lower()) for u in draft_units]
    for i, line in enumerate(material.lines):
        # Every limit in the line, minus any that sits inside a longer one ("not deployed to production"
        # is part of "prototype, not deployed to production" and is said once).
        found = [m for pattern in _HEDGE for m in pattern.finditer(line.text)]
        spans = [m for m in found if not any(o is not m and o.start() <= m.start() and m.end() <= o.end()
                                             and (o.end() - o.start()) > (m.end() - m.start()) for o in found)]
        for hedge in spans:
            limit = hedge.group(0).strip(" ()")
            rest = material.stems[i] - content_stems(limit)
            if len(rest) < 3:
                continue
            key_words = [w.lower() for w in tokens(limit) if len(w) > 3][:2] or [limit.lower()]
            carried = [(u, lowered) for u, stems, lowered in unit_stems
                       if len(rest & stems) >= 3 and len(rest & stems) / len(rest) >= CARRIED]
            # Flag only when the point was carried and NO carrier keeps its limit: a sibling sentence that
            # merely shares the label's words is not the point, and the limit may sit in the label itself.
            if carried and not any(any(w in lowered for w in key_words) for _, lowered in carried):
                findings.append(Finding(
                    carried[0][0], "dropped limit", limit,
                    f"your material limits this: “{_clip(line.text)}” — the draft keeps the point without “{limit}”",
                    {"source": line.source, "line": _clip(line.text)}))
    return findings


_LINK = re.compile(r"(?<![@\w.-])(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:/[^\s)\]>\"'<,;]*)?", re.I)


def _address(url: str) -> str:
    """One spelling for one address: "https://www.github.com/Philips-DR/" and "github.com/philips-dr" agree."""
    url = re.sub(r"^[a-z][a-z0-9+.-]*://", "", url.strip().lower())
    return url.removeprefix("www.").rstrip("/.").removesuffix(".git")


def _addresses(text: str) -> list[str]:
    return [_address(m.group(0)) for m in _LINK.finditer(text)]


def _covers(mentioned: str, public: str) -> bool:
    """A mentioned address names a public one: the same address, or an account that holds it. A repository
    under a public account is not itself shown public by the account."""
    return public == mentioned or public.startswith(mentioned + "/")


def _privacy_said(unit: str) -> str | None:
    """The word a sentence uses to say something is kept out of sight. "Not private" says the opposite."""
    for m in PRIVACY.finditer(unit):
        said = m.group(0)
        if said.lower().startswith("not ") or not negated(unit, said):
            return said
    return None


def check_claims(draft: str, lines: list[Line], posting: str = "", public: list[str] | None = None) -> Report:
    """`public` is every address a stranger was found able to open (by web-ai; this has no network). None
    means nothing was checked, which is not the same as [] -- checked, and none is public."""
    material = _Material(lines)
    posting_words = {t.lower() for t in tokens(posting)}
    posting_numbers = set(numbers(posting))
    report = Report(units_checked=0)
    seen: set[tuple[str, str, str]] = set()
    # One address per entry, even when a list arrives as one string ("a b c" or "a, b, c"): it did, in a real run.
    public_as_given = {_address(u): u for entry in public or [] for u in re.split(r"[\s,]+", entry) if u}
    in_draft = _addresses(draft)

    def add(bucket: list[Finding], unit: str, kind: str, token: str, why: str, nearest: dict | None, posting_has: bool) -> None:
        key = (unit, kind, token.lower())
        if key in seen:
            return
        seen.add(key)
        bucket.append(Finding(unit, kind, token, why, nearest, posting_has))

    draft_units = [u for u in units(draft) if not _DATE_ONLY.match(u)]
    for unit in units(draft):
        if _DATE_ONLY.match(unit):
            continue  # a letter's date line is today's date, not a claim
        report.units_checked += 1
        stems = content_stems(unit)
        words = tokens(unit)

        for n in dict.fromkeys(numbers(unit)):
            in_material = any(n in nums for nums in material.numbers)
            if material.line_support(stems, number=n):
                near = material.nearest(stems, number=n)
                if near and len(report.traced) < 25:
                    report.traced.append({"figure": n, "in_your_draft": _clip(unit), **near})
                continue
            why = (f"the figure {n} is in your material, but not in a line about this" if in_material
                   else f"the figure {n} is nowhere in your material")
            add(report.findings, unit, "figure", n, why,
                material.nearest(stems, number=n) if in_material else material.nearest(stems), n in posting_numbers)

        for word in sorted(watch_words_in(unit)):
            category = WATCH_CATEGORY[word]
            # "(prototype, not deployed to production)" is the draft being honest, not claiming.
            if negated(unit, word) or material.line_support(stems, word=word):
                continue
            holders = [ln for i, ln in enumerate(lines) if word in material.words[i]]
            if holders and all(negated(ln.text, word) for ln in holders):
                why = f"your material says the opposite: “{_clip(holders[0].text)}”"
                near = {"source": holders[0].source, "line": _clip(holders[0].text)}
            elif holders:
                why = f"“{word}” ({category}) appears in your material, but not in a line about this"
                near = material.nearest(stems, need=word)
            else:
                why = f"“{word}” ({category}) is nowhere in your material"
                near = material.nearest(stems)
            add(report.findings, unit, "claim word", word, why, near, word in posting_words)

        for tool in tools_named(unit):
            if not tool_in(material.text, TOOLS[tool]):
                add(report.findings, unit, "tool", tool, f"{tool} is nowhere in your material",
                    material.nearest(stems), tool.lower() in posting_words)

        for name in languages_named(unit):
            if name != "English" and not re.search(rf"\b{name}\b", material.text, re.I):
                add(report.findings, unit, "language", name, f"{name} is nowhere in your material",
                    material.nearest(stems), name.lower() in posting_words)

        for level in degree_levels(unit):
            if DEGREE_LEVELS.index(level) > material.degree:
                shown = DEGREE_NAMES[DEGREE_LEVELS[material.degree]] if material.degree >= 0 else "no degree"
                add(report.findings, unit, "credential", DEGREE_NAMES[level],
                    f"your material shows {shown}, not {DEGREE_NAMES[level]}", material.nearest(stems),
                    any(level_word in posting_words for level_word in ("master", "msc", "phd", "doctorate")))

        for i, tok in enumerate(words):
            if _is_name(tok, first=i == 0) and tok.lower() not in material.all_words and stem(tok) not in material.all_stems and tok.lower() not in {
                    n.lower() for n in tools_named(unit)} and tok not in LANGUAGES:
                add(report.names, unit, "name", tok, f"“{tok}” does not appear in your material",
                    material.nearest(stems), tok.lower() in posting_words)

        # Checked against the world, not the material: the material itself said "Repositories are private".
        said = _privacy_said(unit)
        if said:
            here = _addresses(unit)
            about_code = bool(ABOUT_CODE.search(unit)) or any(a.split("/")[0] in CODE_HOSTS for a in here)
            if public is None:
                if about_code:
                    add(report.findings, unit, "unchecked", said, UNCHECKED.format(said), None, False)
            else:
                named = [p for p in public_as_given if any(_covers(a, p) for a in here)]
                # A repository, not an account: every account page is public, which says nothing about its code.
                hosted = [p for p in public_as_given
                          if p.split("/")[0] in CODE_HOSTS and p.count("/") >= 2] if about_code else []
                found = named or hosted
                if found:
                    # Shown: what the draft links to, else what sits under an account it links to, else any. A CV's
                    # header links the account, which would otherwise put every repository level with the two it cites.
                    tiers = ([p for p in found if p in in_draft],
                             [p for p in found if any(_covers(a, p) for a in in_draft)], found)
                    shown = ", ".join(public_as_given[p] for p in next(t for t in tiers if t)[:5])
                    add(report.findings, unit, "public link", said,
                        f"the draft says “{said}”, but these were found public: {shown}", None, False)

        if len(stems) >= MIN_UNIT_STEMS_FOR_OVERLAP:
            covered = len(stems & material.all_stems) / len(stems)
            if covered < WEAK_OVERLAP:
                report.weak.append({"in_your_draft": _clip(unit), "found_in_your_material": f"{round(covered * 100)}%"})

    seen_limits: set[tuple[str, str]] = set()
    for f in dropped_limits(draft_units, material):
        if (f.unit, f.token.lower()) not in seen_limits:
            seen_limits.add((f.unit, f.token.lower()))
            report.findings.append(f)
    report.findings.sort(key=lambda f: KIND_ORDER.index(f.kind))
    report.weak.sort(key=lambda w: int(w["found_in_your_material"].rstrip("%")))
    return report
