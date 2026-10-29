"""./web -- the human front door.

    ./web read URL [--links]    the page's text (and, with --links, its links)
    ./web check URL             does the address answer? (HEAD only)
    ./web github URL            what a stranger sees of a GitHub repository or account

Reads only. The same operations the model is given, in a form a person can read.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from webai import FetchError
from webai.operations import check_link, github_visibility, read_page


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read a web page, check a link, see what a stranger sees on GitHub.")
    sub = parser.add_subparsers(dest="command", required=True)
    read = sub.add_parser("read", help="A page's text")
    read.add_argument("url")
    read.add_argument("--links", action="store_true", help="Also list the page's links")
    sub.add_parser("check", help="Does a link answer?").add_argument("url")
    sub.add_parser("github", help="What a stranger sees on GitHub").add_argument("url")
    args = parser.parse_args(argv)

    try:
        if args.command == "read":
            page = asyncio.run(read_page(args.url))
            print(f"{page['title'] or '(no title)'}  [{page['final_url']}, {page['status']}, "
                  f"{page['size']} bytes, {page['time']}]")
            for warning in page["warnings"]:
                print(f"WARNING: {warning}", file=sys.stderr)
            print(f"\n{page['text']}")
            if args.links:
                print(f"\n{len(page['links'])} links:")
                for link in page["links"]:
                    print(f"  {link['text'][:70]:70}  {link['url']}")
        else:
            run = check_link if args.command == "check" else github_visibility
            print(json.dumps(asyncio.run(run(args.url)), indent=2, ensure_ascii=False))
    except FetchError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
