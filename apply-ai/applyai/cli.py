"""./apply -- the human front door.

    ./apply requirements POSTING.txt CV.md [--fact "..."]...
    ./apply claims DRAFT.md CV.md [--fact "..."]... [--posting POSTING.txt] [--public [URL ...]]

Reads only. Prints what a model would be given, in a form a person can read.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from applyai.operations import claims_report, requirements_report
from applyai.sources import SourceError


def _read(path: str) -> str:
    return Path(path).expanduser().read_text(encoding="utf-8", errors="replace")


def _print_requirements(r: dict[str, Any]) -> None:
    p = r["posting"]
    print(f"{p['requirements_found']} requirements found. Read: {', '.join(p['headings_read']) or '-'}")
    print(f"Skipped: {', '.join(p['headings_skipped']) or '-'}")
    for note in p["notes"]:
        print(f"Note: {note}")
    print("Summary:", ", ".join(f"{k} {v}" for k, v in r["summary"].items()))
    for item in r["requirements"]:
        print(f"\n#{item['id']:<2} {item['status'].upper():9} [{item['kind']}] {item['text'][:110]}")
        for c in item["checks"]:
            print(f"      {c['type']}: needs {c['needs']} -> {'met' if c['met'] else 'NOT met' if c['met'] is False else 'a person decides'}; {c['found'][:150]}")
        for e in item["evidence"]:
            print(f"      line: {e['line'][:120]}")
        if item["words_not_found"]:
            print(f"      words found nowhere: {', '.join(item['words_not_found'])}")
    print("\nTo ask the user:")
    for a in r["ask_the_user"]:
        print(f"  - ({'required' if a['required'] else 'preferred'}, #{', #'.join(map(str, a['ids']))}) {a['question']}")


def _print_claims(r: dict[str, Any]) -> None:
    print(f"{r['units_checked']} sentences checked. {'Clean.' if r['clean'] else str(len(r['findings'])) + ' findings.'}")
    for f in r["findings"]:
        print(f"\n[{f['kind']}] {f['token']}: {f['why']}{'  (also in the posting)' if f.get('also_in_the_posting') else ''}")
        print(f"   draft:   {f['in_your_draft'][:140]}")
        if "nearest_line_in_your_material" in f:
            print(f"   nearest: {f['nearest_line_in_your_material']['line'][:140]}")
    if r["names_to_review"]:
        print("\nNames in the draft that are in neither your material nor the posting:",
              ", ".join(sorted({n["token"] for n in r["names_to_review"]})))
    for w in r["weakly_traced"]:
        print(f"\nweakly traced ({w['found_in_your_material']}): {w['in_your_draft'][:140]}")
    print(f"\n{r['limits']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Checks between a job posting, your material and a draft.")
    sub = parser.add_subparsers(dest="command", required=True)
    req = sub.add_parser("requirements", help="Set a posting's requirements against your material")
    req.add_argument("posting")
    req.add_argument("sources", nargs="+")
    req.add_argument("--fact", action="append", default=[], help="Something you have confirmed")
    cl = sub.add_parser("claims", help="Check a draft's claims against your material")
    cl.add_argument("draft")
    cl.add_argument("sources", nargs="+")
    cl.add_argument("--fact", action="append", default=[])
    cl.add_argument("--posting", help="The posting, so a finding that echoes it is marked")
    cl.add_argument("--public", nargs="*", action="extend", metavar="URL",
                    help="Addresses a stranger can open (checked with web-ai); --public alone: checked, none is")
    args = parser.parse_args(argv)
    try:
        if args.command == "requirements":
            _print_requirements(requirements_report(_read(args.posting), args.sources, args.fact))
        else:
            _print_claims(claims_report(_read(args.draft), args.sources, args.fact,
                                        _read(args.posting) if args.posting else "", public_links=args.public))
    except (SourceError, ValueError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
