"""PDF → DoclingDocument. The only module that imports Docling's converter."""

import hashlib
from pathlib import Path

from docling_core.types.doc import DoclingDocument

CACHE_DIR = Path(".cache/docling")


def pdf_hash(pdf: Path) -> str:
    return hashlib.sha256(pdf.read_bytes()).hexdigest()


def pdf_metadata(pdf: Path) -> tuple[str | None, str | None]:
    """(title, author) from the PDF's document info, when set."""
    import pypdfium2  # installed with Docling

    info = pypdfium2.PdfDocument(str(pdf)).get_metadata_dict()
    return (info.get("Title") or "").strip() or None, (info.get("Author") or "").strip() or None


def is_extracted(pdf: Path) -> bool:
    """Whether Docling has already analysed this PDF (so planning is instant)."""
    return (CACHE_DIR / f"{pdf_hash(pdf)}.json").exists()


# Fewer characters than this per page after a normal pass means the pages are images (a scan).
MIN_CHARS_PER_PAGE = 200


def extract(pdf: Path, on_status=lambda _: None) -> DoclingDocument:
    """Run Docling layout analysis on a PDF, cached by the PDF's content hash. Scanned PDFs (no
    text layer) are detected and re-run with OCR, which is much slower."""
    cached = CACHE_DIR / f"{pdf_hash(pdf)}.json"
    if cached.exists():
        return DoclingDocument.load_from_json(cached)

    doc = _convert(pdf, ocr=False)
    pages = max(len(doc.pages), 1)
    if len(doc.export_to_text()) / pages < MIN_CHARS_PER_PAGE:
        on_status(f"No text layer found: reading {pages} pages with OCR (slow)...")
        doc = _convert(pdf, ocr=True)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    doc.save_as_json(cached)
    return doc


def _convert(pdf: Path, ocr: bool) -> DoclingDocument:
    # Imported lazily: loading the layout models takes several seconds.
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    # Tables are skipped when reading aloud, so their cell structure isn't needed.
    options = PdfPipelineOptions(do_ocr=ocr, do_table_structure=False)
    if ocr:
        # RapidOCR ships with Docling; its torch backend reuses our PyTorch (no onnxruntime needed).
        # Forced on whole pages, since there is no text layer to keep.
        options.ocr_options = RapidOcrOptions(force_full_page_ocr=True, lang=["english"], backend="torch")
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    return converter.convert(str(pdf)).document
