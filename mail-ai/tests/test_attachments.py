"""Tests for attachments on a draft, and for what they do to the send gate.

A CV goes out as an attachment, so the gate has to cover it the way it covers `bcc`: if the
file changes between the review and the send, the send is refused. The reviewer also has to
be able to SEE every file the confirmation covers, and a file whose bytes cannot be read
must stop the review, not be waved through by its name.

Nothing here says how the bytes reach mail-ai. An `Attachment` is a name and bytes.
"""

import base64
import email
import inspect

import pytest

from mailai import drafts, sending
from mailai.compose import (
    Attachment,
    AttachmentUnreadable,
    BadAttachment,
    Composition,
    build_raw,
    draft_body,
)
from mailai.sending import DraftChanged, review, send
from tests.fake_drafts import FakeDrafts

CV = Attachment("cv.pdf", b"%PDF-1.7 cv bytes")
LETTER = Attachment("letter.pdf", b"%PDF-1.7 letter bytes")


def message(*attachments: Attachment) -> Composition:
    return Composition(to="hr@example.org", subject="Application", body="Please find attached.",
                       attachments=tuple(attachments))


def parsed(composition: Composition):
    return email.message_from_bytes(base64.urlsafe_b64decode(build_raw(composition)))


@pytest.fixture
def gmail():
    """A draft with two files on it, as Gmail shows one: names and sizes, bytes elsewhere."""
    service = FakeDrafts()
    service.add("hr@example.org", "Application", "Please find attached.", files=[
        ("cv.pdf", CV.data, "application/pdf"),
        ("letter.pdf", LETTER.data, "application/pdf"),
    ])
    return service


# -- building the message ----------------------------------------------------------------

def test_without_attachments_the_message_is_still_single_part():
    assert not parsed(message()).is_multipart()


def test_attachments_travel_in_order_with_their_exact_bytes_and_the_body_stays_readable():
    built = parsed(message(CV, LETTER))
    assert built.get_content_type() == "multipart/mixed"
    files = [(p.get_filename(), p.get_content_type(), p.get_payload(decode=True))
             for p in built.walk() if p.get_filename()]
    assert files == [("cv.pdf", "application/pdf", CV.data),
                     ("letter.pdf", "application/pdf", LETTER.data)]
    body = next(p for p in built.walk()
                if p.get_content_type() == "text/plain" and not p.get_filename())
    assert body.get_payload(decode=True).decode().strip() == "Please find attached."


def test_a_name_with_accents_and_a_dash_survives_the_trip():
    name = "CV – Ünïcode (final).pdf"
    built = parsed(message(Attachment(name, b"%PDF-1.7 x")))
    assert [p.get_filename() for p in built.walk() if p.get_filename()] == [name]


def test_a_file_type_nobody_knows_goes_as_plain_binary():
    built = parsed(message(Attachment("notes.zzz", b"x")))
    assert [p.get_content_type() for p in built.walk() if p.get_filename()] == [
        "application/octet-stream"]


# -- the fingerprint ---------------------------------------------------------------------

def test_a_message_with_no_attachments_fingerprints_exactly_as_it_did_before():
    """Pinned to what the code produced before attachments existed, so nothing already
    reviewed changes meaning."""
    assert Composition(to="a@x.com", subject="Hi", body="Body").fingerprint() == "6400e75cdabe578e"
    assert (Composition(to="a@x.com", cc="c@x.com", bcc="b@x.com", subject="Hi", body="Body")
            .fingerprint() == "fa570b58a0d713be")


CHANGES = {
    "one added": message(CV, LETTER, Attachment("extra.pdf", b"%PDF-1.7 extra")),
    "one removed": message(CV),
    "all removed": message(),
    "one renamed": message(Attachment("cv-final.pdf", CV.data), LETTER),
    "one byte changed": message(Attachment("cv.pdf", CV.data[:-1] + b"X"), LETTER),
    "order swapped": message(LETTER, CV),
    "names swapped between the files": message(Attachment("cv.pdf", LETTER.data),
                                               Attachment("letter.pdf", CV.data)),
}


@pytest.mark.parametrize("change", CHANGES)
def test_any_change_to_the_attachments_changes_the_fingerprint(change):
    assert CHANGES[change].fingerprint() != message(CV, LETTER).fingerprint()


def test_the_same_attachments_fingerprint_the_same():
    assert message(CV, LETTER).fingerprint() == message(CV, LETTER).fingerprint()


def test_the_text_fields_cannot_trade_characters_either_when_a_file_is_attached():
    """The recipient and the cc sit side by side in what is hashed. With a file on the
    message they must still be told apart, or 'a' + 'bc' passes for 'ab' + 'c'."""
    one = Composition(to="a", cc="bc", subject="Hi", body="Body", attachments=(CV,))
    other = Composition(to="ab", cc="c", subject="Hi", body="Body", attachments=(CV,))
    assert one.fingerprint() != other.fingerprint()


def test_a_message_with_a_file_cannot_pass_for_one_without_whatever_its_body_says():
    """Same recipient, subject and body as a message with no file, plus the file: a
    different message, and a different fingerprint."""
    plain = Composition(to="hr@example.org", subject="Application", body="Please find attached.")
    assert message(CV).fingerprint() != plain.fingerprint()


def test_a_name_and_its_content_cannot_trade_characters():
    """If name and bytes were simply joined, 'a' + 'bc' and 'ab' + 'c' would be the same
    material, and one file could be swapped for another with the confirmation still good."""
    assert (message(Attachment("a", b"bc")).fingerprint()
            != message(Attachment("ab", b"c")).fingerprint())


# -- bytes that are not clean base64 -----------------------------------------------------

def test_a_stray_character_in_base64_is_refused_not_skipped():
    """The standard decoder quietly drops characters outside the alphabet, so a damaged
    file would arrive looking whole. Here the '!' would simply vanish."""
    good = base64.b64encode(CV.data).decode()
    with pytest.raises(BadAttachment):
        Attachment.from_base64("cv.pdf", good[:8] + "!" + good[8:])


def test_the_same_goes_for_bytes_read_back_from_gmail():
    from mailai.mime import decode_bytes

    # 18 bytes make 24 base64 characters with no padding, so a stray character cannot make
    # the padding come out wrong and fail for that reason: only strictness can refuse it.
    raw = b"%PDF-1.7 cv bytes!"
    good = base64.urlsafe_b64encode(raw).decode()
    assert len(good) == 24 and not good.endswith("=")
    assert decode_bytes(good) == raw
    with pytest.raises(ValueError):
        decode_bytes(good[:8] + "!" + good[8:])


# -- reading a draft back from Gmail -----------------------------------------------------

def test_a_draft_with_attachments_reads_back_into_the_same_fingerprint():
    """The gate fingerprints what comes back from Gmail, not what was sent to it. So the
    confirmation `draft_new` hands back must be the one a later review reads back."""
    service = FakeDrafts()
    composition = message(CV, LETTER)
    draft_id = drafts.create(service, composition)["id"]

    read = drafts.read(service, draft_id)
    assert read.body == "Please find attached."
    assert [(a.filename, a.data) for a in read.attachments] == [
        ("cv.pdf", CV.data), ("letter.pdf", LETTER.data)]
    assert read.fingerprint() == composition.fingerprint()
    assert review(service, draft_id).confirmation == composition.fingerprint()


def test_a_file_whose_bytes_are_inside_the_draft_needs_no_second_call():
    data = b"%PDF-1.7 inline"
    text = b"Hello."
    resource = {"message": {"payload": {
        "mimeType": "multipart/mixed",
        "headers": [{"name": "To", "value": "a@x.com"}, {"name": "Subject", "value": "Hi"}],
        "parts": [
            {"mimeType": "text/plain",
             "body": {"data": base64.urlsafe_b64encode(text).decode().rstrip("="),
                      "size": len(text)}},
            {"mimeType": "application/pdf", "filename": "cv.pdf",
             "body": {"data": base64.urlsafe_b64encode(data).decode().rstrip("="),
                      "size": len(data)}},
        ],
    }}}
    read = draft_body(resource)
    assert [(a.filename, a.data) for a in read.attachments] == [("cv.pdf", data)]


# -- when the bytes cannot be read, nothing is reviewed or sent --------------------------

def test_a_failed_read_of_the_bytes_stops_the_review(gmail):
    """A confirmation over the names alone would say 'you reviewed it' about files nobody
    could check."""
    gmail.fetch_mode = "fails"
    with pytest.raises(AttachmentUnreadable):
        review(gmail, "d1")


def test_a_failed_read_of_the_bytes_stops_the_send(gmail):
    confirmation = review(gmail, "d1").confirmation
    gmail.fetch_mode = "fails"
    with pytest.raises(AttachmentUnreadable):
        send(gmail, "d1", confirmation)
    assert gmail.sent == []


def test_a_short_read_is_unreadable_not_a_smaller_file(gmail):
    """Gmail says how big each file is. Fewer bytes than that would put a fingerprint on
    part of a file while the whole of it is what goes out."""
    gmail.fetch_mode = "short"
    with pytest.raises(AttachmentUnreadable):
        review(gmail, "d1")


def test_a_draft_that_needs_a_second_call_but_was_given_no_way_to_make_one_is_unreadable(gmail):
    with pytest.raises(AttachmentUnreadable):
        draft_body(gmail.store["d1"])


# -- the gate, end to end ----------------------------------------------------------------

def test_a_reviewed_draft_with_attachments_sends(gmail):
    send(gmail, "d1", review(gmail, "d1").confirmation)
    assert gmail.sent == ["d1"]


EDITS = {
    "a file replaced by another": lambda g: g.replace_attachment(
        "d1", "cv.pdf", b"%PDF-1.7 somebody else's cv"),
    "a file added": lambda g: g.attach("d1", "extra.pdf", b"%PDF-1.7 extra"),
    "a file removed": lambda g: g.drop_attachment("d1", "letter.pdf"),
    "a file renamed": lambda g: g.rename_attachment("d1", "cv.pdf", "invoice.pdf"),
}


@pytest.mark.parametrize("edit", EDITS)
def test_an_attachment_edited_after_review_is_refused(gmail, edit):
    """The draft id does not change when a file does. Only the fingerprint notices."""
    reviewed = review(gmail, "d1")
    EDITS[edit](gmail)
    with pytest.raises(DraftChanged):
        send(gmail, "d1", reviewed.confirmation)
    assert gmail.sent == []


def test_reviewing_again_after_an_attachment_edit_allows_the_new_version(gmail):
    review(gmail, "d1")
    gmail.replace_attachment("d1", "cv.pdf", b"%PDF-1.7 the corrected cv")
    send(gmail, "d1", review(gmail, "d1").confirmation)
    assert gmail.sent == ["d1"]


# -- what the reviewer sees --------------------------------------------------------------

def test_a_review_lists_every_attachment_it_fingerprints_with_its_size(gmail):
    """Approving what you cannot see is not approval."""
    lines = review(gmail, "d1").rendered().splitlines()
    for attachment in (CV, LETTER):
        line = next(line for line in lines if attachment.filename in line)
        assert f"{len(attachment.data)} bytes" in line


def test_a_review_of_a_draft_with_no_attachments_mentions_none():
    service = FakeDrafts()
    service.add("a@x.com", "Hi", "Body")
    assert "ttach" not in review(service, "d1").rendered()


# -- the structure that makes the gate a gate --------------------------------------------

def test_nothing_in_the_sending_module_takes_an_attachment():
    """`send` takes a draft id and a confirmation. If a file could be passed in beside them,
    sending something nobody reviewed would be one argument away."""
    forbidden = {"attachment", "attachments", "filename", "data", "file", "files", "path"}
    for name, function in inspect.getmembers(sending, inspect.isfunction):
        if function.__module__ != sending.__name__:
            continue
        assert not (set(inspect.signature(function).parameters) & forbidden), name


def test_drafting_with_attachments_never_sends():
    service = FakeDrafts()
    draft_id = drafts.create(service, message(CV, LETTER))["id"]
    drafts.delete(service, draft_id)
    assert service.sent == []


# -- names and content that are refused --------------------------------------------------

HOSTILE_NAMES = {
    "empty": "",
    "only spaces": "   ",
    "a line break that would add a header": "cv.pdf\r\nBcc: evil@x.com",
    "a null": "cv\x00.pdf",
    "a tab": "cv\t.pdf",
    "a way up the folders": "../../etc/passwd",
    "a forward slash": "dir/cv.pdf",
    "a back slash": "dir\\cv.pdf",
    "dots": "..",
    "a right-to-left override, which makes cv<exe-name>.pdf read as a pdf": "cv‮fdp.exe",
    "too long": "x" * 256,
}


@pytest.mark.parametrize("why", HOSTILE_NAMES)
def test_a_hostile_filename_is_refused(why):
    with pytest.raises(BadAttachment):
        Attachment(HOSTILE_NAMES[why], b"%PDF-1.7 x")


@pytest.mark.parametrize("name", [
    "cv.pdf",
    "Philip_Baah_Afriyie_CV_World_Bank.pdf",
    "CV – Ünïcode (final).pdf",
    "x" * 255,
])
def test_an_ordinary_filename_is_accepted(name):
    assert Attachment(name, b"%PDF-1.7 x").filename == name


def test_an_empty_file_is_refused():
    """A failed export that yields zero bytes must not go out as somebody's CV."""
    with pytest.raises(BadAttachment):
        Attachment("cv.pdf", b"")
