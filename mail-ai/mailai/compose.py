"""Building an RFC 822 message, and the fingerprint the send gate turns on.

Pure: no network, no credentials, no Gmail. Everything here is a function of its arguments,
which is what lets the gate's behaviour be tested exhaustively without a mailbox.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import mimetypes
import re
import struct
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any

MAX_NAME_LENGTH = 255

# Characters that change which way a name reads. "cv‮fdp.exe" shows as "cvexe.pdf".
_BIDI_CONTROLS = frozenset(
    "؜‎‏‪‫‬‭‮⁦⁧⁨⁩"
)
_MIME_TYPE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")


class BadAttachment(ValueError):
    """A file that will not be attached: a name that is not safe to show, or no content."""


class AttachmentUnreadable(Exception):
    """A draft's attachment could not be read back from Gmail.

    Never worked around. A confirmation over a file whose bytes nobody could check would
    say "you reviewed it" about something nobody did.
    """


def _check_filename(name: object) -> None:
    if not isinstance(name, str) or not name.strip():
        raise BadAttachment("an attachment needs a file name")
    if len(name) > MAX_NAME_LENGTH:
        raise BadAttachment(f"a file name is at most {MAX_NAME_LENGTH} characters: {name[:40]!r}...")
    if name in (".", ".."):
        raise BadAttachment(f"{name!r} is not a file name")
    for character in name:
        if character in "/\\":
            raise BadAttachment(f"a file name cannot hold a slash: {name!r}")
        # Cc covers a line break, which would add a header; Cs cannot be written out at all.
        if (character in _BIDI_CONTROLS
                or unicodedata.category(character) in ("Cc", "Cs", "Zl", "Zp")):
            raise BadAttachment(f"a file name cannot hold a hidden or control character: {name!r}")


@dataclass(frozen=True)
class Attachment:
    """A file on a message: a name and its bytes. How the bytes arrived is not its concern."""

    filename: str
    data: bytes
    # Empty means "work it out from the name" (see build_raw).
    mime_type: str = ""

    def __post_init__(self) -> None:
        _check_filename(self.filename)
        if not isinstance(self.data, (bytes, bytearray)):
            raise BadAttachment(f"{self.filename!r}: content must be bytes")
        if not self.data:
            raise BadAttachment(f"{self.filename!r} is empty")
        if self.mime_type and not _MIME_TYPE.match(self.mime_type):
            raise BadAttachment(f"{self.filename!r}: {self.mime_type!r} is not a file type")

    @classmethod
    def from_base64(cls, filename: str, data: str, mime_type: str = "") -> Attachment:
        """Standard base64, strictly: a stray character is refused, not skipped."""
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as error:
            raise BadAttachment(f"{filename!r}: the content is not valid base64") from error
        return cls(filename, raw, mime_type)

    @property
    def size(self) -> int:
        return len(self.data)


def _length_prefixed(fields: list[bytes]) -> bytes:
    """Each field behind its own length, so no field can run into the next."""
    return b"".join(struct.pack(">Q", len(field)) + field for field in fields)


@dataclass(frozen=True)
class Composition:
    """What a draft says. The unit the gate fingerprints."""

    to: str
    subject: str
    body: str
    cc: str = ""
    bcc: str = ""
    # Set when replying, so other clients thread it correctly (see build_raw).
    in_reply_to: str = ""
    references: str = ""
    attachments: tuple[Attachment, ...] = ()

    def fingerprint(self) -> str:
        """A hash of everything that would actually be sent.

        This is what makes "you reviewed it" mean something. A draft id alone is not
        enough: a draft can be edited between the moment it was shown to someone and the
        moment send is called, and the id does not change when it is. Fingerprinting the
        content means the gate refuses a draft that is no longer the one that was read.

        bcc is included deliberately -- silently adding a recipient after review is exactly
        the edit this is meant to catch. Attachments are included for the same reason: the
        file is the part of an application nobody re-reads, and swapping it is an edit the
        draft id would never show.
        """
        text_fields = (self.to, self.cc, self.bcc, self.subject, self.body)
        if not self.attachments:
            # Exactly as before attachments existed, so nothing already reviewed changes.
            material = "\x00".join(field.strip() for field in text_fields)
            return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]

        fields = [field.strip().encode("utf-8") for field in text_fields]
        fields.append(struct.pack(">Q", len(self.attachments)))
        for attachment in self.attachments:
            fields.append(attachment.filename.encode("utf-8"))
            fields.append(hashlib.sha256(attachment.data).digest())
        # 0xFF is never the first byte of UTF-8 text, so this can never equal the material
        # of a message without attachments, whatever its body says.
        return hashlib.sha256(b"\xff" + _length_prefixed(fields)).hexdigest()[:16]


def build_raw(composition: Composition) -> str:
    """An RFC 822 message, base64url-encoded the way Gmail's `raw` field wants it.

    In-Reply-To and References carry the ORIGINAL message's RFC 822 Message-ID, which is
    not the same thing as Gmail's own message id. Setting Gmail's `threadId` alone makes a
    reply thread correctly in Gmail's own UI and nowhere else -- every other mail client
    threads on these headers, so a reply sent without them arrives as a new conversation
    for anyone not using Gmail.
    """
    message = EmailMessage()
    message["To"] = composition.to
    if composition.cc:
        message["Cc"] = composition.cc
    if composition.bcc:
        message["Bcc"] = composition.bcc
    message["Subject"] = composition.subject
    if composition.in_reply_to:
        message["In-Reply-To"] = composition.in_reply_to
        # References is the whole chain; falling back to In-Reply-To gives a one-link
        # chain, which is correct for a reply to a thread's first message.
        message["References"] = composition.references or composition.in_reply_to
    message.set_content(composition.body)

    for attachment in composition.attachments:
        mime_type = (attachment.mime_type or mimetypes.guess_type(attachment.filename)[0]
                     or "application/octet-stream")
        maintype, _, subtype = mime_type.partition("/")
        message.add_attachment(
            bytes(attachment.data), maintype=maintype, subtype=subtype,
            filename=attachment.filename,
        )

    return base64.urlsafe_b64encode(message.as_bytes()).decode()


def reply_subject(original: str) -> str:
    """"Re: x", and never "Re: Re: x" -- accretion is what normalise_subject undoes."""
    stripped = original.strip()
    return stripped if stripped.lower().startswith("re:") else f"Re: {stripped}"


def _read_attachment(part: dict[str, Any],
                     fetch: Callable[[str], bytes] | None) -> Attachment:
    """One file part of a draft, with its bytes, or AttachmentUnreadable. Nothing in between."""
    from mailai.mime import decode_bytes

    name = str(part.get("filename", ""))
    body = part.get("body", {}) or {}
    try:
        attachment_id = body.get("attachmentId")
        if attachment_id:
            if fetch is None:
                raise AttachmentUnreadable(
                    f"{name!r} is kept apart from the draft, and no way to fetch it was given"
                )
            data = fetch(str(attachment_id))
        elif body.get("data"):
            data = decode_bytes(str(body["data"]))
        else:
            raise AttachmentUnreadable(f"{name!r} came back with no content")

        # Gmail says how big the file is. Fewer bytes than that is part of a file, and a
        # fingerprint of part of a file is no check on the whole one that goes out.
        if "size" in body and int(body["size"]) != len(data):
            raise AttachmentUnreadable(
                f"{name!r} came back as {len(data)} bytes where the draft says {body['size']}"
            )
        return Attachment(name, data, str(part.get("mimeType", "")))
    except AttachmentUnreadable:
        raise
    except Exception as error:
        raise AttachmentUnreadable(f"{name!r} could not be read from the draft: {error}") from error


def draft_body(draft: dict[str, Any],
               fetch_attachment: Callable[[str], bytes] | None = None) -> Composition:
    """Read a Gmail draft resource back into the Composition it represents.

    The gate fingerprints THIS, recomputed from the draft's current state at send time,
    rather than anything remembered from when it was created.

    `fetch_attachment` turns an attachment id into its bytes. Gmail keeps a file apart from
    the draft that holds it, so the bytes come from a second call that the caller makes
    possible; this module stays free of the network.
    """
    from mailai.mime import attachment_parts, body_text, headers

    payload = draft.get("message", {}).get("payload", {}) or {}
    head = headers(payload)
    return Composition(
        to=head.get("to", ""),
        cc=head.get("cc", ""),
        bcc=head.get("bcc", ""),
        subject=head.get("subject", ""),
        body=body_text(payload),
        in_reply_to=head.get("in-reply-to", ""),
        references=head.get("references", ""),
        attachments=tuple(
            _read_attachment(part, fetch_attachment) for part in attachment_parts(payload)
        ),
    )
