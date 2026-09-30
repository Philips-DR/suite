"""Command line: python -m audiobook {preview,render} BOOK.pdf ..."""

import argparse
import os
from pathlib import Path

from .preview import chapter_label, format_duration, speech_seconds


def load_env(path: Path = Path(".env")) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def parse_selection(spec: str, count: int) -> list[int]:
    """Parse '1-3,5' into 1-based chapter numbers; every number must exist."""
    numbers: set[int] = set()
    for part in spec.split(","):
        first, _, last = part.partition("-")
        numbers.update(range(int(first), int(last or first) + 1))
    bad = sorted(n for n in numbers if not 1 <= n <= count)
    if bad:
        raise ValueError(f"no chapter {bad[0]}: this book has {count} (see preview)")
    return sorted(numbers)


def parse_speed(value: str) -> float:
    speed = float(value)
    if not 0.5 <= speed <= 2.0:
        raise argparse.ArgumentTypeError("speed must be between 0.5 and 2.0, e.g. 0.95")
    return speed


def cmd_preview(args: argparse.Namespace) -> None:
    from .operations import preview_book

    print(f"Analysing {args.pdf} (first run takes ~3-4 s per page; cached afterwards)...")
    result = preview_book(args.pdf, args.out)
    for i, c in enumerate(result.plan.chapters, 1):
        note = "  [appendix]" if c.appendix else ""
        print(f"{i:3d}. {chapter_label(i, c):60.60}  {format_duration(speech_seconds(c.spoken_chars)):>8}{note}")
    print(f"\nExact spoken text: {result.preview_path}\nPlan data:         {result.plan_path}")


def cmd_render(args: argparse.Namespace) -> None:
    from .operations import plan_book, render_pdf
    from .render import Progress, format_clock

    load_env()
    selected = parse_selection(args.chapters, len(plan_book(args.pdf).chapters)) if args.chapters else None

    def show(p: Progress) -> None:
        eta = f" · ~{format_clock(p.seconds_left)} left" if p.seconds_left else ""
        print(f"\r  [{p.fraction:4.0%}] chapter {p.chapter}: {p.chapter_title[:40]:40} {p.chunks_done}/{p.chunks_total}{eta}   ",
              end="", flush=True)

    def chapter_done(mp3: Path, seconds: float) -> None:
        print(f"\n  -> {mp3} ({format_clock(seconds)})")

    book = render_pdf(args.pdf, args.voice, selected, args.speed, args.m4b, args.out,
                      on_progress=show, on_chapter_done=chapter_done)
    if book:
        print(f"Audiobook: {book}")


def cmd_voice_add(args: argparse.Namespace) -> None:
    from .voices import add_voice

    load_env()
    print("Only clone voices you own or have the speaker's permission to use.", flush=True)
    result = add_voice(args.name, args.clip, args.start, args.end, search=not args.no_search, overwrite=args.overwrite,
                       on_status=print)
    for w in result.warnings:
        print(f"warning: {w}")
    v = result.voice
    score = f", similarity {v.similarity:.3f}" if v.similarity else ""
    print(f"Saved voice '{v.name}' from {v.window[0]:.1f}-{v.window[1]:.1f} s of {args.clip}{score}")
    print(f"Hear it:  python -m audiobook voice test {v.name}")


def cmd_voice_test(args: argparse.Namespace) -> None:
    from .voices import SAMPLE_TEXT, test_voice

    load_env()
    out = test_voice(args.name, Path("output/voices") / f"{args.name}-test.mp3", args.text or SAMPLE_TEXT, args.speed)
    print(f"Sample: {out}")


def cmd_voice_list(args: argparse.Namespace) -> None:
    from .voices import list_voices

    voices = list_voices()
    print("Your voices:")
    for v in (v for v in voices if v.kind == "cloned"):
        details = []
        if v.window:
            details.append(f"{v.window[0]:.1f}-{v.window[1]:.1f} s of {v.source}")
        if v.similarity:
            details.append(f"similarity {v.similarity:.3f}")
        print(f"  {v.name:16} {', '.join(details)}")
    print("Built-in voices:\n  " + ", ".join(v.name for v in voices if v.kind == "preset"))


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from .web.app import create_app

    load_env()
    print(f"Library: {args.library.resolve()}\nOpen http://127.0.0.1:{args.port}")
    # Localhost only: the app has no authentication.
    uvicorn.run(create_app(args.library), host="127.0.0.1", port=args.port, log_level="warning")


def main() -> None:
    parser = argparse.ArgumentParser(prog="audiobook", description="Turn a PDF into an audiobook read in a cloned voice.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("preview", help="Show exactly what will be read aloud, without rendering audio")
    p.add_argument("pdf", type=Path)
    p.add_argument("--out", type=Path, help="Output directory (default: output/<pdf name>)")
    p.set_defaults(func=cmd_preview)

    r = sub.add_parser("render", help="Render the audiobook")
    r.add_argument("pdf", type=Path)
    r.add_argument("--voice", required=True, help="A voice name from 'voice list' (e.g. abigail), or an audio file to clone")
    r.add_argument("--chapters", help="Chapters to render, numbered as in preview, e.g. '1-3,5' (default: all)")
    r.add_argument("--out", type=Path, help="Output directory (default: output/<pdf name>)")
    r.add_argument("--m4b", action="store_true", help="Also build a single .m4b audiobook with chapter markers")
    r.add_argument("--speed", type=parse_speed, default=0.95, help="Playback speed, 0.5-2.0 (default 0.95). Pitch is unchanged")
    r.set_defaults(func=cmd_render)

    v = sub.add_parser("voice", help="Add, test and list voices").add_subparsers(dest="voice_command", required=True)
    va = v.add_parser("add", help="Clone a voice from a recording (any audio format)")
    va.add_argument("name", help="Name to use with --voice, e.g. abigail")
    va.add_argument("clip", type=Path)
    va.add_argument("--start", type=float, help="Use the recording from this second...")
    va.add_argument("--end", type=float, help="...to this second (max 30 s of reference is used)")
    va.add_argument("--no-search", action="store_true", help="Don't try several windows of a long recording")
    va.add_argument("--overwrite", action="store_true", help="Replace an existing voice with this name")
    va.set_defaults(func=cmd_voice_add)
    vt = v.add_parser("test", help="Hear a voice read a sample paragraph")
    vt.add_argument("name")
    vt.add_argument("--text", help="Text to read instead of the sample")
    vt.add_argument("--speed", type=parse_speed, default=0.95)
    vt.set_defaults(func=cmd_voice_test)
    v.add_parser("list", help="List voices").set_defaults(func=cmd_voice_list)

    sv = sub.add_parser("serve", help="Run the web app on this computer")
    sv.add_argument("--library", type=Path, default=Path("library"), help="Folder of PDFs (uploads go here)")
    sv.add_argument("--port", type=int, default=8000)
    sv.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    try:
        args.func(args)
    except (ValueError, FileExistsError, FileNotFoundError) as e:
        parser.exit(1, f"error: {e}\n")


if __name__ == "__main__":
    main()
