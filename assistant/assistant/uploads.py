"""Files a person hands the assistant: audio to transcribe, markdown to turn into a Doc.

The assistant owns the uploads folder; the tools never learn it exists. An upload ends in a
path, and a path is what meet-ai and docu-ai already take -- so a file uploaded here and a
file that was always on disk are the same thing to every tool.

Everything a browser sends is a name to distrust. Every path component is checked, the
result must resolve inside the uploads folder, and a file is written to a `.part` name and
renamed only once complete, so a half-received upload is never listed or transcribed.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, AsyncIterator

AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".flac", ".ogg", ".opus", ".webm", ".mp4", ".aac", ".wma"}
DOC_EXTS = {".md"}
# A two-hour meeting is ~115 MB as m4a and ~350 MB as FLAC; four hours of WAV is ~2.5 GB.
MAX_AUDIO_BYTES = 4 * 1024**3
MAX_DOC_BYTES = 20 * 1024**2
PART = ".part"

_BAD_COMPONENT = re.compile(r"[\x00-\x1f/\\]")


class UploadError(Exception):
    """Something the person can fix, phrased for them."""


def _clean_component(name: str) -> str:
    name = name.strip()
    if not name or name in (".", "..") or _BAD_COMPONENT.search(name) or name.startswith("."):
        raise UploadError(f"not an acceptable file or folder name: {name!r}")
    return name


def _inside(root: Path, candidate: Path) -> Path:
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise UploadError("that path would land outside the uploads folder")
    return resolved


def unique(path: Path) -> Path:
    """`meeting.m4a`, then `meeting (2).m4a` -- never overwrite what someone uploaded before."""
    if not path.exists() and not path.with_name(path.name + PART).exists():
        return path
    for n in range(2, 10_000):
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists() and not candidate.with_name(candidate.name + PART).exists():
            return candidate
    raise UploadError("too many files with that name already")


def audio_target(root: Path, name: str) -> Path:
    name = _clean_component(Path(name).name)
    if Path(name).suffix.lower() not in AUDIO_EXTS:
        raise UploadError(f"{name} is not an audio file this can transcribe "
                          f"({', '.join(sorted(AUDIO_EXTS))})")
    folder = root / "audio"
    folder.mkdir(parents=True, exist_ok=True)
    return _inside(root, unique(folder / name))


def new_batch(root: Path, name: str) -> str:
    """A folder for one set of markdown. Its name becomes the Doc's default title, so it is
    the uploaded folder's own name, or the file's, made unique."""
    name = _clean_component(Path(name).name.removesuffix(".md").removesuffix(".MD") or "Documents")
    folder = root / "docs"
    folder.mkdir(parents=True, exist_ok=True)
    batch = unique(folder / name)
    _inside(root, batch).mkdir()
    return batch.name


def doc_target(root: Path, batch: str, name: str) -> Path:
    """One markdown file, directly inside its batch -- docu-ai reads only a folder's top level,
    so a nested file would upload and then silently do nothing."""
    batch_dir = _inside(root, root / "docs" / _clean_component(batch))
    if not batch_dir.is_dir():
        raise UploadError(f"no upload batch {batch!r}; start one first")
    name = _clean_component(name)
    if Path(name).suffix.lower() not in DOC_EXTS:
        raise UploadError(f"{name} is not a markdown (.md) file")
    target = batch_dir / name
    if target.exists():
        raise UploadError(f"{name} is already in this upload")
    return _inside(root, target)


async def receive(target: Path, chunks: AsyncIterator[bytes], limit: int) -> int:
    """Stream to `<target>.part`, then rename. Nothing half-written is ever visible."""
    part = target.with_name(target.name + PART)
    size = 0
    try:
        with part.open("xb") as out:
            async for chunk in chunks:
                size += len(chunk)
                if size > limit:
                    raise UploadError(f"{target.name} is larger than the {limit // 1024**2} MB limit")
                out.write(chunk)
        if size == 0:
            raise UploadError(f"{target.name} is empty")
        part.rename(target)
        return size
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def doc_path(batch_dir: Path) -> Path:
    """What to hand docu-ai: the file itself when a batch holds one, which gets one tab and no
    cover; the folder when it holds several, which gets a tab per file and a contents page."""
    files = sorted(p for p in batch_dir.iterdir() if p.suffix.lower() in DOC_EXTS)
    return files[0] if len(files) == 1 else batch_dir


def listing(root: Path) -> dict[str, Any]:
    audio_dir, docs_dir = root / "audio", root / "docs"
    audio = [
        {"name": p.name, "path": str(p), "bytes": p.stat().st_size, "at": p.stat().st_mtime}
        for p in sorted(audio_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS
    ] if audio_dir.is_dir() else []
    docs = []
    if docs_dir.is_dir():
        for batch in sorted(docs_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            files = sorted(p.name for p in batch.glob("*.md")) if batch.is_dir() else []
            if files:
                docs.append({"name": batch.name, "path": str(doc_path(batch)), "files": files,
                             "at": batch.stat().st_mtime})
    return {"audio": audio, "docs": docs}

