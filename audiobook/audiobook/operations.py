"""What the audiobook tool can be asked to do: data in, data out.

Front doors (the CLI and the web app) call these and format the results for their audience.
Nothing here prints or exits.
"""

import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from . import background
from .plan import BookPlan, build_plan
from .preview import RENDER_SPEED, chapter_label, format_duration, render_preview, speech_seconds
from .speech import parse_corrections

AUDIO = (".mp3", ".m4b")
DEFAULT_SPEED = 0.95


@dataclass
class PreviewResult:
    plan: BookPlan
    preview_path: Path
    plan_path: Path


def output_dir(pdf: Path) -> Path:
    return Path("output") / pdf.stem


def plan_book(pdf: Path) -> BookPlan:
    from .extract import extract, pdf_metadata  # Docling is slow to import; keep it off the CLI's startup path.

    title, author = pdf_metadata(pdf)
    return build_plan(extract(pdf), fallback_title=title or pdf.stem, author=author, corrections=load_corrections(pdf))


def corrections_path(pdf: Path) -> Path:
    """Typos in the source text, next to the PDF: book.pdf → book.corrections.txt"""
    return pdf.with_suffix(".corrections.txt")


def load_corrections(pdf: Path) -> list[tuple[str, str]]:
    path = corrections_path(pdf)
    return parse_corrections(path.read_text()) if path.exists() else []


def preview_book(pdf: Path, out_dir: Path | None = None) -> PreviewResult:
    plan = plan_book(pdf)
    out = out_dir or output_dir(pdf)
    out.mkdir(parents=True, exist_ok=True)
    preview_path = out / "preview.md"
    preview_path.write_text(render_preview(plan, str(pdf)))
    plan_path = out / "plan.json"
    plan_path.write_text(json.dumps(asdict(plan), indent=1, ensure_ascii=False))
    return PreviewResult(plan, preview_path, plan_path)


def render_pdf(
    pdf: Path,
    voice: str,
    chapters: list[int] | None = None,
    speed: float = 0.95,
    m4b: bool = False,
    out_dir: Path | None = None,
    on_progress: "Callable | None" = None,
    on_chapter_done: Callable[[Path, float], None] | None = None,
) -> Path | None:
    """Render chapters (1-based, as numbered by preview; default all). Returns the M4B path if built."""
    from .render import render_book
    from .tts import Narrator

    plan = plan_book(pdf)
    selected = chapters or list(range(1, len(plan.chapters) + 1))
    bad = [n for n in selected if not 1 <= n <= len(plan.chapters)]
    if bad:
        raise ValueError(f"no chapter {bad[0]}: this book has {len(plan.chapters)}")
    narrator = Narrator(voice)
    return render_book(
        [(n, plan.chapters[n - 1]) for n in selected], narrator, out_dir or output_dir(pdf), plan.title, m4b, speed,
        on_progress=on_progress, on_chapter_done=on_chapter_done,
    )


# ---------------------------------------------------------------------------
# For a model: what a book is, what a voice is, and long work as background jobs.
#
# A PDF is named by its path, wherever it lives; everything the tool makes goes in its own
# `output/`, which is relative to the folder every front door runs from.
# ---------------------------------------------------------------------------


def parse_selection(spec: str, count: int) -> list[int]:
    """Parse '1-3,5' into 1-based chapter numbers; every number must exist."""
    numbers: set[int] = set()
    for part in spec.split(","):
        first, _, last = part.strip().partition("-")
        try:
            low, high = int(first), int(last or first)
        except ValueError:
            raise ValueError(f"chapters must look like '1-3,5', not '{spec}'") from None
        # Checked before the range is expanded, so '1-99999999999' cannot build a giant set, and a
        # reversed '5-3' is an error instead of silently selecting nothing (which renders everything).
        if low > high:
            raise ValueError(f"'{part.strip()}' runs backwards: write it as {high}-{low}")
        for n in (low, high):
            if not 1 <= n <= count:
                raise ValueError(f"no chapter {n}: this book has {count} (see preview)")
        numbers.update(range(low, high + 1))
    return sorted(numbers)


def check_speed(speed: float) -> float:
    if not 0.5 <= speed <= 2.0:
        raise ValueError("speed must be between 0.5 and 2.0, e.g. 0.95")
    return speed


def pdf_file(path: str | Path) -> Path:
    pdf = Path(path).expanduser()
    if pdf.suffix.lower() != ".pdf":
        raise ValueError(f"{pdf.name} is not a PDF")
    if not pdf.is_file():
        raise FileNotFoundError(f"no PDF at {pdf}")
    return pdf.resolve()


def book_overview(pdf: Path) -> dict:
    """What a book will be: its chapters, how long each is, and how much was left out. Planning is
    instant once Docling has analysed the PDF; before that this says so instead of waiting minutes."""
    from .extract import is_extracted

    if not is_extracted(pdf):
        return {"pdf": str(pdf), "analysed": False,
                "hint": "Docling has not read this PDF yet. start_analysis does that in the "
                        "background (about 2-4 seconds a page, cached afterwards)."}
    plan = plan_book(pdf)
    total = sum(c.spoken_chars for c in plan.chapters)
    skipped = Counter(s.reason for c in plan.chapters for s in c.skipped)
    return {
        "pdf": str(pdf), "analysed": True, "title": plan.title, "author": plan.author,
        "chapters": [
            {"number": i, "label": chapter_label(i, c), "appendix": c.appendix,
             "words": sum(len(s.text.split()) for s in c.segments),
             "speech": format_duration(speech_seconds(c.spoken_chars))}
            for i, c in enumerate(plan.chapters, 1)
        ],
        "speech": format_duration(speech_seconds(total)),
        "render_time": format_duration(speech_seconds(total) / RENDER_SPEED),
        "citations_removed": sum(c.citations_removed for c in plan.chapters),
        "skipped": dict(skipped.most_common()),
        "corrections": str(corrections_path(pdf)) if corrections_path(pdf).exists() else None,
        "output_dir": str(output_dir(pdf).resolve()),
    }


def chapter_text(pdf: Path, chapter: int, start: int = 0, limit_chars: int = 20000) -> dict:
    """The exact text the narrator will speak for one chapter, as segments from `start`. A long
    chapter comes back truncated with next_start set; call again with start=next_start."""
    from .extract import is_extracted

    if not is_extracted(pdf):
        raise ValueError("this PDF has not been analysed yet: call start_analysis first")
    plan = plan_book(pdf)
    if not 1 <= chapter <= len(plan.chapters):
        raise ValueError(f"no chapter {chapter}: this book has {len(plan.chapters)}")
    selected = plan.chapters[chapter - 1]
    segments, used = [], 0
    for index in range(max(start, 0), len(selected.segments)):
        seg = selected.segments[index]
        if segments and used + len(seg.text) > limit_chars:
            return {"chapter": chapter, "label": chapter_label(chapter, selected), "announce": selected.announce
                    or selected.title, "segments": segments, "truncated": True, "next_start": index}
        segments.append({"kind": seg.kind, "text": seg.text})
        used += len(seg.text)
    return {"chapter": chapter, "label": chapter_label(chapter, selected),
            "announce": selected.announce or selected.title, "segments": segments,
            "truncated": False, "next_start": None}


def voice_choices() -> list[dict]:
    from .voices import list_voices

    return [asdict(v) for v in list_voices()]


def list_audiobooks(root: Path | None = None) -> list[dict]:
    """Every book with audio in the output folder: its files, newest first."""
    root = root or Path("output")
    books = []
    for folder in sorted(p for p in root.glob("*") if p.is_dir()) if root.is_dir() else []:
        files = sorted(f for f in folder.iterdir() if f.suffix in AUDIO)
        if not files:
            continue
        books.append({
            "book": folder.name, "folder": str(folder.resolve()),
            "files": [{"name": f.name, "path": str(f.resolve()), "megabytes": round(f.stat().st_size / 1e6, 1),
                       "modified": f.stat().st_mtime} for f in files],
            "updated": max(f.stat().st_mtime for f in files),
        })
    return sorted(books, key=lambda b: -b["updated"])


def check_voice(voice: str, allow_file: bool = True) -> str:
    """A voice a job can actually use, as the name to hand it: a saved or built-in name, or (for a
    render) an existing audio file to clone, as its full path -- the job runs elsewhere and would not
    expand a `~`."""
    from .voices import list_voices

    known = list_voices()
    if voice in {v.name for v in known}:
        return voice
    if allow_file and Path(voice).expanduser().is_file():
        return str(Path(voice).expanduser().resolve())
    names = ", ".join(v.name for v in known if v.kind == "cloned") or "none yet"
    raise ValueError(f"no voice '{voice}'. Cloned voices here: {names}; built-in presets work too (list_voices).")


def start_analysis(pdf: Path, jobs_dir: Path) -> dict:
    """Run Docling over a PDF in the background. It is the slow first step; everything after it
    (preview, reading the text, rendering) works from its cache."""
    return asdict(background.start("analyse", str(pdf), jobs_dir, ["preview", str(pdf)]))


def start_render(pdf: Path, voice: str, jobs_dir: Path, chapters: str | None = None,
                 speed: float = DEFAULT_SPEED, m4b: bool = False) -> dict:
    """Render chapters in the background. Everything that can be wrong is checked here, before
    a job exists: a render that fails in its first second is a job nobody should have to poll."""
    from .extract import is_extracted

    if not is_extracted(pdf):
        raise ValueError("this PDF has not been analysed yet: call start_analysis first")
    check_speed(speed)
    voice = check_voice(voice)
    selected = parse_selection(chapters, len(plan_book(pdf).chapters)) if chapters else None
    arguments = ["render", str(pdf), "--voice", voice, "--speed", f"{speed:g}"]
    if selected:
        arguments += ["--chapters", chapters]
    if m4b:
        arguments.append("--m4b")
    return asdict(background.start("render", str(pdf), jobs_dir, arguments))


def get_corrections(pdf: Path) -> dict:
    """The book's corrections file as text: `find => replace` lines for what the source got wrong
    (a typo, a name the voice cannot say). Empty when there is none."""
    path = corrections_path(pdf)
    return {"path": str(path), "text": path.read_text() if path.exists() else ""}


def set_corrections(pdf: Path, text: str) -> dict:
    """Replace the book's corrections. Applied the next time the book is planned, so previews and
    renders pick them up at once; chunks already spoken stay cached, and only changed text is re-read."""
    ignored = [line.strip() for line in text.splitlines()
               if line.strip() and not line.strip().startswith("#") and not parse_corrections(line)]
    path = corrections_path(pdf)
    path.write_text(text)
    return {"path": str(path), "pairs": len(parse_corrections(text)), "ignored": ignored}


def start_voice_clone(name: str, clip: Path, consent: str, jobs_dir: Path, overwrite: bool = False) -> dict:
    """Clone a voice from a recording, in the background. Only voices the person owns or has the
    speaker's permission to use: `consent` says which, and is kept with the voice."""
    from .voices import NAME, PRESETS, VOICES_DIR

    if not consent.strip():
        raise ValueError("say whose voice this is and that they agreed to it being cloned (consent)")
    if not NAME.match(name):
        raise ValueError("voice name: lowercase letters, digits, - and _ only")
    if name in PRESETS:
        raise ValueError(f"'{name}' is a built-in voice; pick another name")
    if (VOICES_DIR / f"{name}.safetensors").exists() and not overwrite:
        raise ValueError(f"voice '{name}' already exists (pass overwrite to replace it)")
    if not clip.is_file():
        raise FileNotFoundError(f"no recording at {clip}")
    arguments = ["voice", "add", name, str(clip), f"--consent={consent.strip()}"]
    if overwrite:
        arguments.append("--overwrite")
    return asdict(background.start("voice", str(clip), jobs_dir, arguments))


def start_voice_sample(name: str, jobs_dir: Path, speed: float = DEFAULT_SPEED) -> dict:
    """Have a voice read a sample paragraph, in the background; about half a minute. The MP3 is
    the job's output. Judge a clone with this before committing hours of rendering to it."""
    check_speed(speed)
    # A name only: the sample is written under output/voices/<name>-test.mp3, and a path as the name
    # would put it wherever that path points.
    check_voice(name, allow_file=False)
    return asdict(background.start("sample", name, jobs_dir, ["voice", "test", name, "--speed", f"{speed:g}"]))


def job_status(jobs_dir: Path, job_id: str | None = None) -> dict | None:
    """One job by id, or the most recent. Refreshed from its process and its log."""
    job = background.get(jobs_dir, job_id) if job_id else background.latest(jobs_dir)
    return asdict(job) if job else None
