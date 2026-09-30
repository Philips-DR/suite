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


def extract(pdf: Path) -> DoclingDocument:
    """Run Docling layout analysis on a PDF, cached by the PDF's content hash."""
    cached = CACHE_DIR / f"{pdf_hash(pdf)}.json"
    if cached.exists():
        return DoclingDocument.load_from_json(cached)

    # Imported lazily: loading the layout models takes several seconds.
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    # Tables are skipped when reading aloud, so their cell structure isn't needed; OCR is only
    # needed for scanned PDFs (plan.md M6).
    options = PdfPipelineOptions(do_ocr=False, do_table_structure=False)
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    doc = converter.convert(str(pdf)).document

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    doc.save_as_json(cached)
    return doc
