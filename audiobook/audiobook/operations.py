"""What the audiobook tool can be asked to do: data in, data out.

Front doors (the CLI and the web app) call these and format the results for their audience.
Nothing here prints or exits.
"""

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from .plan import BookPlan, build_plan
from .preview import render_preview
from .speech import parse_corrections


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
