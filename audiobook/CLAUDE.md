# CLAUDE.md

Guidance for Claude Code when working in this folder. It is one tool of the suite (`../CLAUDE.md`
holds the rules that cover all of them) and also runs alone from here.

## Project

An audiobook generator: a PDF is extracted and cleaned, and narrated in English by a local TTS
engine using a voice the user chooses — either a built-in preset voice or a voice cloned from a
short reference clip.

**`plan.md` holds the locked decisions, the design and the milestone order. This file holds the
engineering rules and the facts learned the hard way.** When the two disagree, fix whichever is
wrong. Status: M0–M8 done. M3's speech rules are a first pass driven by one book; extend them as the user
reports misreadings. `preview` and `render` both run on Docling + BookPlan (the PyMuPDF reader
is gone).

**Two front doors, no interface of its own.** The CLI (`python -m audiobook`) and the MCP door
(`./mcp`, which the suite's assistant launches) both sit on `operations.py`; neither wraps the
other. The standalone web app this tool once had was removed on 2026-10-10: its features (read a
book, check what will be spoken, corrections, voices, render with progress, play and download) are
the **Audiobooks** panel of the suite's web app (`../web`), which reaches them through the
assistant. Don't add a UI here.

Language is Python, decided deliberately: Pocket TTS and the strong PDF-layout tools (Docling) are
Python-only, and time is spent in model inference, not the host language. Don't propose a
TypeScript rewrite; the interface is TypeScript already, in the suite's `../web`.

## Target hardware (matters for engine choice)

- CPU-only in practice: Intel i5/i7 Whiskey Lake-U (8 threads), ~14 GB RAM.
- GPUs present are an Intel UHD 620 and an AMD Radeon PRO WX 3200 (Polaris, 4 GB) — neither is
  usable for PyTorch acceleration (no CUDA, Polaris is not supported by ROCm). Assume `device="cpu"`.
- A full book is hours of audio, so the engine must run at or above real-time on CPU.
- Python 3.14 in **this tool's own venv**, `.venv/` — never the suite's shared one. `./setup` at the
  suite's top builds it from `requirements.txt` (every version pinned, with PyTorch's CPU index
  declared in the file) and `requirements-dev.txt` (pytest); alone: `python3 -m venv .venv &&
  .venv/bin/pip install -r requirements.txt -r requirements-dev.txt`. Why separate (measured
  2026-10-10): it is 1.9 GB against the shared 696 MB, nothing else in the suite uses torch, Docling
  or Pocket TTS, and torch has to come from PyTorch's CPU index (PyPI's default is a multi-GB CUDA
  build). Packages in common are only fastapi, uvicorn, starlette, numpy, pydantic and
  huggingface_hub, at patch-level differences — it is the weight and the index, not a conflict,
  that decided it. `./mcp` and the job launcher both use this venv.
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
.venv/bin/python -m audiobook preview book.pdf        # exact spoken text → output/<book>/preview.md
.venv/bin/python -m audiobook render book.pdf --voice abigail --chapters 1
.venv/bin/python -m audiobook render book.pdf --voice abigail --m4b
.venv/bin/python -m audiobook render book.pdf --voice abigail --speed 1.0   # default is 0.95 → *-0.95x.mp3
.venv/bin/python -m audiobook voice add NAME CLIP [--start S --end E]      # clone; long clips are searched
.venv/bin/python -m audiobook voice test NAME        # → output/voices/NAME-test.mp3
.venv/bin/python -m audiobook voice list
.venv/bin/python -m pytest -q                         # no models, network or token needed
```

Run everything from this folder: `output/`, `voices/`, `.cache/` and `.env` are relative to it (`./mcp`
and the background jobs do this themselves).

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
- `audiobook/operations.py` — `plan_book`, `preview_book`, `render_pdf`, and what the MCP door needs on
  top: `book_overview`, `chapter_text`, corrections, `list_audiobooks`, `start_*`, `job_status`. What
  both front doors call.
- `audiobook/background.py` — analysing, rendering and voice work as detached background jobs.
- `audiobook/mcp_server.py` — the MCP door (12 tools); `./mcp` launches it.
- `audiobook/voices.py` — `add_voice` (window search scored by WavLM similarity), `test_voice`,
  `list_voices`; metadata in `voices/NAME.json`.
- `audiobook/__main__.py` — CLI and `.env` loading.
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
- Front doors (the CLI and the MCP door) call functions in `operations.py`; neither wraps the other.

## The suite integration (2026-10-10)

How it was joined to the suite, and the rules that came out of running it for real:

- **Long work is a detached process, not a thread.** `background.start` launches
  `python -m audiobook …` inside `bash -c '"$@"; echo "[exit $?]"'` with `start_new_session`, so the
  backend restarting (or dying) does not stop it. Verified: a render survived `pkill` of the backend
  and the restarted backend picked up the same job id, mid-render, and saw it finish. The wrapper's
  `[exit N]` line is how a crash, a finish and a kill are told apart — **`interrupted` means that
  line never appeared**. Progress is parsed from the CLI's own output (`[ 40%] chapter 2: …`), so
  changing those print formats in `__main__.py` breaks `background.PROGRESS`; the tests say so.
- **One job at a time, any kind.** Docling and the voice model each use every core. State is
  `.jobs/<id>.json` plus `.log` (git-ignored); a pid is trusted only if `/proc/<pid>/cmdline` shows
  our marker and the job's target.
- **A stopped render loses nothing:** every spoken chunk is in `.cache/audio/<voice id>/`, so
  starting it again continues, and a new speed is only a re-encode. Docling's cache is keyed by the
  PDF's content hash, so a re-uploaded copy of a book is already "read".
- **Everything that can be wrong is checked before a job exists** (`operations.start_render`: analysed,
  voice, speed, chapters): a render failing in its first second is a job nobody should have to poll.
- **The gate is the tools' own annotations.** Six tools only read (`list_*`, `preview_book`,
  `read_chapter`, `get_corrections`, `job_status`); the five that start work or write a file are not
  read-only, so chat asks first and `tests/test_mcp_door.py` pins the split.
- **Cloning needs a consent statement, and the model must not write it.** `start_voice_clone` refuses an
  empty `consent`, its description tells the model to ask the user, and the text is kept in
  `voices/NAME.json`. In chat the approval card shows it before anything runs.
- **Corrections are reported, not guessed at.** `set_corrections` returns every line that did not become
  a correction (`parse_corrections` skips them silently, so a typo would otherwise do nothing and say
  nothing). A line with **nothing to find** (`=> PG`) is one of them: applied, `replace("", "PG")`
  puts PG between every character of the book.
- **A chapter selection is validated before it is expanded.** A reversed `5-3` selected nothing, and
  nothing selected means *render everything*; `1-99999999999` built the whole set first. Each part is
  now checked against the book's chapter count before `range()` sees it (`operations.parse_selection`,
  shared with the CLI).
- **A sample is for a voice by name, never a path.** `voice test NAME` writes
  `output/voices/NAME-test.mp3`; with an absolute path as the name that lands wherever it points. A
  *render* may still clone from an audio file, and gets it as a full path (a `~` would not be expanded
  by the job).
- **Ask whether the process is alive before reading its log** (`background.refresh`). Read in the other
  order, a job that wrote `[exit 0]` and exited between the two looks gone with no exit line, and is
  recorded as `interrupted` for good. `interrupted` is final, and jobs are ordered by id, never by
  file timestamp (re-saving a dead job used to move it ahead of newer ones). Two `start` calls at
  once were both let through until `_START` made check-and-launch atomic.
- **Cancel stops the whole process group, and writes its marker first.** `background.cancel` writes
  `.jobs/<id>.cancel`, *then* sends SIGTERM to the group (the job is its own session, so its pid is
  its group), then SIGKILL if anything is left after 5 s. The marker has to come first: once the
  process is gone, any status poll must be able to tell `cancelled` from `interrupted` (which tells
  people "starting again resumes"), and an answer only written after the kill loses that race. A job
  that had in fact finished — its `[exit 0]` is in the log — is `done`, whatever the marker says.
- **"Is the job alive" means "is anything alive in its process group", not "is the wrapper".** The
  first cancel watched only the wrapper: SIGTERM killed it at once, the check said "stopped", and
  members that ignore SIGTERM kept running (found because a test leaked them). The same weakness let
  a killed wrapper turn a still-rendering job into "interrupted", inviting a second render beside it.
  `is_our_job` now scans `/proc` for group members that name the target and the marker or
  `python -m audiobook`; `cancel` waits for the group to empty, not for one pid.
  A render stopped this way loses nothing (chunk cache); reading a book and cloning start over.
- **Audio is served by the assistant, from `output/` only** (`tools.yaml`: `files: [output]`; see
  `assistant/CLAUDE.md`). Nothing here knows about HTTP.
- **Verified for real (2026-10-10):** a voice sample in `abigail` from the new venv, transcribed with
  Whisper, matched its text 100%; a chapter rendered to MP3 + M4B (chapter marker present) with live
  percent and time left; the same through chat (preview, approval card, render) and through the
  web panel in Chrome. The new venv resolved `transformers` 5.19.0 where the old one had 5.17.0;
  nothing in the plan rules, the golden tests or the speech changed.

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
