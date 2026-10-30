"""What apply-ai can be asked to do, as data in and data out.

Both front doors (the CLI and the MCP server) sit on these; neither wraps the other. Each returns a plain
dict: the model reads it as JSON, the CLI formats it for a person.

Everything here only reads. There is no operation that writes a document, sends anything or changes a
file, so nothing here needs an approval gate -- the document a draft becomes is written by the assistant's
own gated tool, after these have been run.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from applyai.claims import MAX_FINDINGS, check_claims
from applyai.evidence import GAP, CHECK, NOT_FOUND, PARTLY, SUPPORTED, TRAIT, match, question_for, source_names
from applyai.posting import DUTY, read_posting
from applyai.sources import gather

STATUS_ORDER = (GAP, CHECK, NOT_FOUND, PARTLY, TRAIT, SUPPORTED)

REQUIREMENTS_NEXT = (
    "Before drafting anything: (1) Read `ask_the_user`. An item that comes from a check (a degree, a language, "
    "a tool, years of experience) is certain: the material does not show it. An item that is only `not_found` "
    "means no line shares the requirement's words, so look through the material yourself first and ask only "
    "about what it really does not show. (2) Put the questions to the user in ONE message and wait for the "
    "answers; do not draft past an open question. (3) Record each confirmed answer with `remember` (kind "
    "'fact', a subject naming the CV claim), and pass those facts in `facts` when you call this or `claims` "
    "again, so no one is asked twice. (4) Never write into a draft anything the user has not confirmed for a "
    "gap. Say plainly in your reply which required items the draft does not claim. (5) Draft, then run `claims` "
    "on the draft before saving it."
)

CLAIMS_NEXT = (
    "Resolve every finding before `write_draft`: cut the claim, or ask the user and record the answer, then pass "
    "it in `facts` and check again. A finding marked `also_in_the_posting` may only be the employer, place or "
    "role being named; if the sentence says the user DID or HAS it, it is a claim and needs the user's word. Read "
    "each `weakly_traced` sentence against the material. An `unchecked` finding means the draft says code is "
    "private and nothing has looked: check the addresses with web-ai and call this again with `public_links`. "
    "In your reply, say which findings you kept and why. "
    "`clean: true` means nothing this check looks for was unsupported; it does not prove the sentences are true."
)

LIMITS = (
    "This checks figures, words that overstate (how often, how much, who did it, how big or real, how long, what "
    "level), tools, languages, degrees and names against the material, and a claim that code is private against "
    "the addresses found public. It cannot tell that a sentence is true: a claim worded without any of those can "
    "still be wrong. The nearest line is shown so a person can judge quickly."
)


def requirements_report(posting: str, paths: list[str], facts: list[str], roots: list[Path] | None = None,
                        today: date | None = None) -> dict[str, Any]:
    reading = read_posting(posting)
    lines = gather(paths, facts, roots)
    matched = match(reading.requirements, lines, today)

    counts = {status: sum(m.status == status for m in matched) for status in STATUS_ORDER}
    asks: list[dict[str, Any]] = []
    asked: dict[tuple[str, str], dict[str, Any]] = {}
    unmatched_duties: list[str] = []
    for m in matched:
        if m.requirement.kind == DUTY and m.status == NOT_FOUND:
            unmatched_duties.append(f"#{m.requirement.id} {m.requirement.text[:120]}")
            continue
        question = question_for(m)
        if not question:
            continue
        failing = next((c for c in m.checks if c.met is not True), None)
        key = (failing.type, failing.needs) if failing else ("text", str(m.requirement.id))
        if key in asked:
            asked[key]["ids"].append(m.requirement.id)
            if m.requirement.kind == "required":
                asked[key]["required"] = True
            continue
        entry = {"ids": [m.requirement.id], "required": m.requirement.kind == "required", "question": question}
        asked[key] = entry
        asks.append(entry)
    asks.sort(key=lambda a: not a["required"])

    return {
        "posting": {
            "requirements_found": len(reading.requirements),
            "headings_read": reading.read,
            "headings_skipped": reading.skipped,
            "notes": reading.notes,
        },
        "material": {"files": source_names(lines), "lines": len(lines), "confirmed_facts": len(facts)},
        "summary": counts,
        "ask_the_user": asks,
        "duties_with_no_matching_line": unmatched_duties,
        "requirements": [
            {
                "id": m.requirement.id,
                "kind": m.requirement.kind,
                "section": m.requirement.section,
                "text": m.requirement.text,
                "status": m.status,
                "checks": [{k: v for k, v in {"type": c.type, "needs": c.needs, "found": c.found, "met": c.met,
                                              "note": c.note}.items() if v not in ("", None) or k == "met"}
                           for c in m.checks],
                "evidence": m.evidence,
                "words_not_found": m.words_not_found,
            }
            for m in sorted(matched, key=lambda m: (STATUS_ORDER.index(m.status), m.requirement.id))
        ],
        "meaning_of_status": {
            GAP: "a hard check failed: the material does not show it (certain)",
            CHECK: "a person has to decide (years of experience)",
            NOT_FOUND: "no line shares this requirement's words (look before asking)",
            PARTLY: "some of its words appear: read the evidence lines",
            TRAIT: "a quality of character (proactive, integrity...) that no search can find: show it through real "
                   "examples already in the material, never assert it bare, never invent one",
            SUPPORTED: "a hard check passed, or the lines clearly match",
        },
        "next_step": REQUIREMENTS_NEXT,
    }


def claims_report(draft: str, paths: list[str], facts: list[str], posting: str = "",
                  roots: list[Path] | None = None, *, public_links: list[str] | None = None) -> dict[str, Any]:
    if not draft.strip():
        raise ValueError("the draft is empty")
    lines = gather(paths, facts, roots)
    report = check_claims(draft, lines, posting, public_links)

    unknown_names = [f for f in report.names if not f.in_posting]
    posting_names = sorted({f.token for f in report.names if f.in_posting}, key=str.lower)
    return {
        "units_checked": report.units_checked,
        "clean": not report.findings,
        "findings": [f.as_dict() for f in report.findings[:MAX_FINDINGS]],
        "findings_not_shown": max(0, len(report.findings) - MAX_FINDINGS),
        "names_to_review": [f.as_dict() for f in unknown_names[:20]],
        "names_that_come_from_the_posting": ", ".join(posting_names),
        "weakly_traced": report.weak[:8],
        "figures_traced": report.traced,
        "limits": LIMITS,
        "next_step": CLAIMS_NEXT,
    }
