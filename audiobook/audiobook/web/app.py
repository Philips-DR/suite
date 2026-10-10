"""Local web app: upload a PDF, check what will be read, pick a voice, render, listen.

A front door like the CLI: it calls `operations` / `voices` and formats results as JSON. Long work
runs in the one-at-a-time JobQueue. Bind to localhost only — there is no authentication.
"""

import re
import shutil
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from .. import operations, voices
from ..preview import chapter_label, format_duration, speech_seconds
from .jobs import JobQueue

STATIC = Path(__file__).parent / "static"
AUDIO = (".mp3", ".m4b")
SAFE_NAME = re.compile(r"^[\w.-]+$")


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", Path(name).stem.lower()).strip("-")[:60] or "book"


class RenderRequest(BaseModel):
    voice: str
    chapters: list[int] | None = None
    speed: float = 0.95
    m4b: bool = False


class CorrectionsBody(BaseModel):
    text: str


def create_app(library: Path) -> FastAPI:
    library.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="Audiobook")
    jobs = JobQueue()

    def book_pdf(book: str) -> Path:
        pdf = library / f"{book}.pdf"
        if not SAFE_NAME.match(book) or not pdf.exists():
            raise HTTPException(404, f"no book '{book}'")
        return pdf

    def outputs(pdf: Path) -> list[dict]:
        out = operations.output_dir(pdf)
        files = sorted(p for p in out.glob("*") if p.suffix in AUDIO) if out.exists() else []
        return [{"name": p.name, "url": f"/files/{pdf.stem}/{p.name}", "size": p.stat().st_size} for p in files]

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (STATIC / "index.html").read_text()

    # --- books -----------------------------------------------------------------------------

    @app.get("/api/books")
    def list_books():
        from ..extract import is_extracted, pdf_metadata

        books = []
        for pdf in sorted(library.glob("*.pdf")):
            title, author = pdf_metadata(pdf)
            books.append({"id": pdf.stem, "title": title or pdf.stem, "author": author, "analysed": is_extracted(pdf)})
        return books

    @app.post("/api/books")
    def upload_book(file: UploadFile = File(...)):
        if not (file.filename or "").lower().endswith(".pdf"):
            raise HTTPException(400, "please upload a PDF")
        pdf = library / f"{slug(file.filename)}.pdf"
        with pdf.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        job = jobs.submit("analyse", f"Reading {file.filename}", lambda update: _analyse(pdf, update))
        return {"book": pdf.stem, "job": job.to_dict()}

    def _analyse(pdf: Path, update) -> dict:
        update(message="Analysing layout (about 2-4 s per page)...")
        operations.plan_book(pdf)
        return {"book": pdf.stem}

    @app.post("/api/books/{book}/analyse")
    def analyse(book: str):
        pdf = book_pdf(book)
        return jobs.submit("analyse", f"Reading {pdf.name}", lambda update: _analyse(pdf, update)).to_dict()

    @app.get("/api/books/{book}")
    def get_book(book: str):
        from ..extract import is_extracted

        pdf = book_pdf(book)
        if not is_extracted(pdf):
            raise HTTPException(409, "not analysed yet")
        plan = operations.plan_book(pdf)
        chapters = []
        for i, c in enumerate(plan.chapters, 1):
            chapters.append({
                "number": i, "label": chapter_label(i, c), "announce": c.announce or c.title, "appendix": c.appendix,
                "words": sum(len(s.text.split()) for s in c.segments),
                "speech": format_duration(speech_seconds(c.spoken_chars)),
                "segments": [asdict(s) for s in c.segments],
                "skipped": [asdict(s) for s in c.skipped], "citations_removed": c.citations_removed,
            })
        total = sum(c.spoken_chars for c in plan.chapters)
        return {"id": book, "title": plan.title, "author": plan.author, "chapters": chapters,
                "speech": format_duration(speech_seconds(total)), "outputs": outputs(pdf)}

    @app.get("/api/books/{book}/corrections")
    def get_corrections(book: str):
        path = operations.corrections_path(book_pdf(book))
        return {"text": path.read_text() if path.exists() else ""}

    @app.put("/api/books/{book}/corrections")
    def put_corrections(book: str, body: CorrectionsBody):
        operations.corrections_path(book_pdf(book)).write_text(body.text)
        return {"ok": True}

    @app.post("/api/books/{book}/render")
    def render(book: str, req: RenderRequest):
        pdf = book_pdf(book)
        if not 0.5 <= req.speed <= 2.0:
            raise HTTPException(400, "speed must be between 0.5 and 2.0")

        def run(update):
            from ..render import format_clock

            done = []

            def progress(p):
                update(progress=p.fraction, seconds_left=p.seconds_left,
                       message=f"Chapter {p.chapter}: {p.chapter_title} ({p.chunks_done}/{p.chunks_total})")

            def chapter_done(mp3: Path, seconds: float):
                done.append({"name": mp3.name, "url": f"/files/{pdf.stem}/{mp3.name}", "length": format_clock(seconds)})
                update(files=list(done))

            m4b = operations.render_pdf(pdf, req.voice, req.chapters, req.speed, req.m4b,
                                        on_progress=progress, on_chapter_done=chapter_done)
            if m4b:
                done.append({"name": m4b.name, "url": f"/files/{pdf.stem}/{m4b.name}"})
            return {"files": done}

        which = f"chapters {', '.join(map(str, req.chapters))}" if req.chapters else "all chapters"
        return jobs.submit("render", f"Rendering {book}, {which}, voice {req.voice}", run).to_dict()

    @app.get("/files/{folder}/{name}")
    def file(folder: str, name: str):
        if not (SAFE_NAME.match(folder) and SAFE_NAME.match(name)) or Path(name).suffix not in AUDIO:
            raise HTTPException(404)
        path = Path("output") / folder / name
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(path, media_type="audio/mp4" if path.suffix == ".m4b" else "audio/mpeg")

    # --- voices ----------------------------------------------------------------------------

    @app.get("/api/voices")
    def list_voices():
        return [asdict(v) for v in voices.list_voices()]

    @app.post("/api/voices")
    def add_voice(name: str = Form(...), clip: UploadFile = File(...), consent: bool = Form(False)):
        if not consent:
            raise HTTPException(400, "confirm you own this voice or have the speaker's permission")
        suffix = Path(clip.filename or "clip").suffix or ".audio"
        upload = voices.VOICES_DIR / f".upload-{slug(name)}{suffix}"
        voices.VOICES_DIR.mkdir(exist_ok=True)
        with upload.open("wb") as f:
            shutil.copyfileobj(clip.file, f)

        def run(update):
            try:
                result = voices.add_voice(name, upload, on_status=lambda msg: update(message=msg))
            finally:
                upload.unlink(missing_ok=True)
            return {"voice": asdict(result.voice), "warnings": result.warnings}

        return jobs.submit("voice-add", f"Cloning voice '{name}'", run).to_dict()

    @app.post("/api/voices/{name}/test")
    def test_voice(name: str, speed: float = 0.95):
        if not SAFE_NAME.match(name):
            raise HTTPException(404)

        def run(update):
            update(message="Speaking a sample paragraph...")
            out = voices.test_voice(name, Path("output/voices") / f"{name}-test.mp3", speed=speed)
            return {"files": [{"name": out.name, "url": f"/files/voices/{out.name}"}]}

        return jobs.submit("voice-test", f"Sample of voice '{name}'", run).to_dict()

    # --- jobs ------------------------------------------------------------------------------

    @app.get("/api/jobs")
    def list_jobs():
        return [j.to_dict() for j in jobs.list()]

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: int):
        if job_id not in jobs.jobs:
            raise HTTPException(404)
        return jobs.jobs[job_id].to_dict()

    return app
