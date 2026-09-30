# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

An audiobook generator: the user uploads a PDF, the text is extracted and cleaned, and it is
narrated in English by a local TTS engine using a voice the user chooses — either a built-in
preset voice or a voice cloned from a short reference clip.

**`plan.md` holds the locked decisions, the design and the milestone order. This file holds the
engineering rules and the facts learned the hard way.** When the two disagree, fix whichever is
wrong. Status: M0–M7 done. M3's speech rules are a first pass driven by one book; extend them as the user
reports misreadings. `preview` and `render` both run on Docling + BookPlan (the PyMuPDF reader
is gone). Next: M3 (speech clean-up + `voice` commands).

Language is Python, decided deliberately: Pocket TTS and the strong PDF-layout tools (Docling) are
Python-only, and time is spent in model inference, not the host language. Don't propose a
TypeScript rewrite; a TS web UI may sit in front later (plan.md M7).

## Target hardware (matters for engine choice)

- CPU-only in practice: Intel i5/i7 Whiskey Lake-U (8 threads), ~14 GB RAM.
- GPUs present are an Intel UHD 620 and an AMD Radeon PRO WX 3200 (Polaris, 4 GB) — neither is
  usable for PyTorch acceleration (no CUDA, Polaris is not supported by ROCm). Assume `device="cpu"`.
- A full book is hours of audio, so the engine must run at or above real-time on CPU.
- Python 3.14 in a project venv at `.venv/` (created with `python3 -m venv .venv`; `uv` is not
  installed). PyTorch is the CPU-only build from `https://download.pytorch.org/whl/cpu`.
- `ffmpeg` is installed and is used for audio concatenation and encoding.

## Chosen engine: Pocket TTS, with voice cloning

The user chose **Pocket TTS** and wants voices **cloned** from a reference clip (not presets).

- API: `TTSModel.load_model()` → `model.get_state_for_audio_prompt(wav_or_preset_or_safetensors)`
  → `model.generate_audio(state, text)` returns a 1-D torch tensor at `model.sample_rate` (24 kHz).
- Cache cloned voices with `pocket_tts.export_model_state(state, "voice.safetensors")`; loading
  the `.safetensors` is much faster than re-encoding the WAV.
- Cloning weights are gated on Hugging Face (terms already accepted on the user's account). The
  token lives in `.env` as `HF_TOKEN` (git-ignored, mode 600) and the CLI loads it. Without it,
  only the built-in preset voices work and cloning raises `ValueError`.
- Pocket TTS reads reference WAVs with Python's `wave` module, so they must be 16-bit PCM —
  float WAVs fail with `wave.Error: unknown format: 3`. `tts.prepare_reference` converts any input
  with ffmpeg.
- The clone reproduces the reference audio's quality (noise, room echo), so clean the clip first.
- The user's voice is **`abigail`**: `voices/abigail.safetensors`, cloned from
  `voices/abigail.wav` = 0.3–29.0 s of `voice/abigail.mp3`, unprocessed (24 kHz mono s16). The
  source is low-bitrate (32 kbps, 22 kHz) mono. The user says the speaker consented; personal use only.
- Clone-likeness findings (WavLM speaker similarity vs held-out real speech; real-vs-real = 0.99):
  ~30 s prompts beat shorter ones (11 s 0.94, 19 s 0.95, 30 s 0.96); highpass+loudnorm slightly
  hurts; `temp` and decode steps don't help (defaults best). **Prompts over ~30 s break generation**
  (no EOS, similarity 0.71) — `voice add` must cap at 30 s. User rated v1 (0.95) "80% like her".
- Measured on this machine: model load ~8 s (first run also downloads weights), voice cloning
  ~2.5 s, generation ~1.4× real-time. A 10-hour book takes roughly 7 hours to render, hence the
  chunk cache.

## Other TTS engines considered

Keep the engine behind a common interface (see Architecture) so these can be added later.

| Engine | Role | Voice selection | License | Notes |
|---|---|---|---|---|
| **Pocket TTS** (kyutai-labs) | Default | ~26 presets + cloning from a `.wav` | MIT | 100M params, faster than real-time on CPU, supports Py 3.10–3.14. `pip install pocket-tts` |
| **Kokoro-82M** (hexgrad) | Fast preset voices | ~54 preset voices, no cloning | Apache 2.0 | Needs `espeak-ng`. `pip install kokoro` |
| **Chatterbox** (Resemble AI) | Highest-quality cloning | Cloning from ~10 s clip | MIT | Turbo (350M) wants a GPU; Nano (110M) is the CPU option. Tested on Py 3.11. Output is watermarked |
| **NeuTTS Air** (Neuphonic) | Alternative CPU cloning | Cloning from 3–15 s clip **plus its transcript** | Apache 2.0 | GGUF/llama.cpp builds for CPU. Output is watermarked |

Avoid for this project: XTTS-v2 and F5-TTS (non-commercial weight licenses, slow on CPU), and
`edge-tts` as a core dependency (free but an unofficial cloud endpoint with no cloning).

Voice cloning: only clone voices the user owns or has permission to use. Reference clips should
be clean, mono, single-speaker WAV with no music or background noise.

## Usage

```bash
.venv/bin/python -m audiobook serve --library /home/philip/Documents/books   # web app on 127.0.0.1:8000
.venv/bin/python -m audiobook preview book.pdf        # exact spoken text → output/<book>/preview.md
.venv/bin/python -m audiobook render book.pdf --voice abigail --chapters 1
.venv/bin/python -m audiobook render book.pdf --voice abigail --m4b
.venv/bin/python -m audiobook render book.pdf --voice abigail --speed 1.0   # default is 0.95 → *-0.95x.mp3
.venv/bin/python -m audiobook voice add NAME CLIP [--start S --end E]      # clone; long clips are searched
.venv/bin/python -m audiobook voice test NAME        # → output/voices/NAME-test.mp3
.venv/bin/python -m audiobook voice list
.venv/bin/python -m pytest -q                         # no models, network or token needed
```

`--voice` takes a saved voice's name (`abigail`, `tina`), a `.safetensors` path, an audio file to
clone, or a preset like `alba`. Output goes to `output/<pdf name>/`. `--chapters` uses the numbers shown by `preview`.
`--speed` (0.5–2.0, **default 0.95** — the user's choice) is ffmpeg `atempo` applied at encode time — pitch
unchanged, and speech comes from the chunk cache, so a new speed costs seconds, not a re-render.

**Tried and rejected (2026-09-30) — don't re-propose without a new reason.** Output is the voice's
raw chunks + fixed silences + `atempo`, nothing else; the user compared by ear and chose this ("A")
as clearest.
- *Levelling*: the voice starts each sentence ~4.6 dB louder than the rest (inherited from the real
  reader, +4.2 dB; not caused by chunking). A heavy compressor + make-up gain closed the gap to
  0.6 dB but audibly reduced clarity (flattened within-word dynamics 14.6 → 12.2 dB). A slow gain
  curve kept dynamics (14.1 dB, gap 1.6 dB) but the user reverted everything before judging it.
- *Pause control*: replacing the voice's own pauses with fixed true silence. One sentence per
  generation gave exact pauses but duller consonants; shaping pauses inside multi-sentence chunks
  kept clarity but was reverted along with levelling.

## Code layout

- `audiobook/extract.py` — Docling conversion, cached in `.cache/docling/<pdf sha256>.json`; PDFs
  with no text layer are re-run with OCR (RapidOCR, torch backend).
- `audiobook/plan.py` — pure `DoclingDocument → BookPlan`: walk (skip labels + their children),
  heading levels from numbering, chapters, section filters, citations, paragraph joining,
  front matter, empty headings, then corrections + `speech.for_speech`. Every drop is a `Skipped`.
- `audiobook/speech.py` — pure rewrites for what the voice misreads, each verified by synthesis +
  Whisper (see its docstring); per-book corrections (`book.corrections.txt` next to the PDF).
- `audiobook/preview.py` — pure `BookPlan → preview.md` (chapter table, exact text, skipped summary).
- `audiobook/operations.py` — `plan_book`, `preview_book`, `render_pdf`: what front doors call.
- `audiobook/voices.py` — `add_voice` (window search scored by WavLM similarity), `test_voice`,
  `list_voices`; metadata in `voices/NAME.json`.
- `audiobook/__main__.py` — CLI and `.env` loading. `audiobook/web/` — FastAPI app (`app.py`), a
  one-at-a-time `JobQueue` (`jobs.py`), and a single no-build page (`static/index.html`). Binds to
  127.0.0.1 only: there is no authentication.
- `audiobook/chunk.py` — sentence chunks ≤400 chars. `audiobook/tts.py` — model loaded once per
  process, `Narrator`, `resolve_voice`. `audiobook/render.py` — speaks a plan `Chapter` with pauses,
  caches each chunk in `.cache/audio/<voice id>/<text hash>.npy`, reports `Progress` (with time
  left) through a callback, encodes MP3/M4B.
- `tests/` — rule unit tests; golden `tests/golden/paper.preview.md` from
  `tests/fixtures/paper.docling.json.gz`. Accept an intended change with `UPDATE_GOLDEN=1` and
  **read the diff** before committing it.

## PDF extraction: Docling

- Pipeline options: `PdfPipelineOptions(do_ocr=False, do_table_structure=False)`. Measured: 125 s
  for a 36-page two-column paper (~3.5 s/page). Cache the result as JSON keyed by PDF hash.
- `doc.iterate_items()` yields body content only; running headers, page numbers and page footnotes
  are in the *furniture* content layer and excluded by default. Don't re-implement header removal.
- Labels to skip: `table`, `formula` (text is empty), `picture`, `caption`, `code`. Skip their
  **children** too — Docling nests table cells and figure text as `text` items inside them.
- `key_value_area` groups are **not** forms here: Docling uses them for "Label: prose" runs
  ("Initialization: …"). Read their children; skipping them lost real content.
- **Docling reports every `section_header` as level 1**, "5." and "5.1." alike. Derive levels from
  the heading numbering.
- Paragraphs interrupted by a figure, formula or page break come out as two `text` items; join
  them when the first lacks sentence-final punctuation and the second doesn't start with an ASCII
  capital or digit (it can start with "Φ(e)").
- The reference list is a `References` heading followed by `list_item`s — drop that section.
- **`footnote` labels are unreliable in books**: dialogue at the foot of a page gets labelled
  `footnote`. Only skip footnotes that start with a marker (`*`, `†`, `1`, `[1]`); read the rest.
- Docling tags some dialogue paragraphs as `list_item`; paragraph joining must treat them like
  paragraphs.
- Title/author come from the PDF's metadata (`pdf_metadata`, via pypdfium2) — ebook title pages are
  often images.
- Measured on the book (163 pages, calibre ebook): Docling 6 min 8 s (~2.3 s/page), no OCR needed.
- OCR: RapidOCR's default onnxruntime backend isn't installed — use `backend="torch"`. Measured on
  2 scanned pages: 98% word accuracy; errors are run-together words ("theagent") and dropped
  spaces, e.g. "et al.,2024" (citation regex tolerates it). Slow: ~1 min/page under load.

## Architecture rules

Stages: extract → plan → voice → speak → assemble (details in plan.md §3).

- Only `extract` imports Docling; only `speak` imports Pocket TTS; only `assemble` writes output
  audio with ffmpeg.
- `plan` is pure (no I/O, no models) and records every dropped element with a reason, so the
  `preview` command can show exactly what is and isn't spoken.
- Front doors (CLI now, web UI later) call functions in `operations.py`; neither wraps the other.

## Conventions

- Python, run via `.venv/bin/python`. Keep dependencies of any extra engines optional so only
  Pocket TTS is required.
- Output and cache directories (e.g. `output/`, `.cache/`) and user reference voice clips are
  not committed.
- Test plan rules against saved Docling JSON fixtures (golden `preview.md` snapshot) so tests need
  no models, network or token. Docling and TTS get opt-in smoke tests.
- Test PDFs in `/home/philip/Documents/books/`: `2609.09153v1.pdf` (36-page arXiv paper: two
  columns, tables, formulas, citations, references, appendices) and `final-quest.pdf` (163-page
  copyrighted book — its fixture is in the git-ignored `tests/fixtures/local/`; never commit it).
