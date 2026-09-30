"""Split paragraphs into sentence-aligned chunks for synthesis."""

import re

# Keep chunks short enough for steady progress and cheap re-renders, but never split a sentence.
MAX_CHUNK_CHARS = 400

SENTENCE_END = re.compile(r"(?<=[.!?…])[\"'”’)\]]*\s+(?=[\"'“‘(\[]?[A-Z0-9])")
ABBREVIATIONS = ("Mr.", "Mrs.", "Ms.", "Dr.", "St.", "Prof.", "Sr.", "Jr.", "vs.", "etc.", "e.g.", "i.e.", "No.")


def split_sentences(paragraph: str) -> list[str]:
    parts = SENTENCE_END.split(paragraph)
    sentences: list[str] = []
    for part in parts:
        # Re-join splits that happened after an abbreviation such as "Mr."
        if sentences and sentences[-1].endswith(ABBREVIATIONS):
            sentences[-1] += " " + part
        else:
            sentences.append(part)
    return [s.strip() for s in sentences if s.strip()]


def chunk_paragraph(paragraph: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    chunks: list[str] = []
    current = ""
    for sentence in split_sentences(paragraph):
        if current and len(current) + 1 + len(sentence) > max_chars:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return chunks
