"""A Gmail drafts stand-in, enough to drive the send gate.

State is named so it cannot collide with the API surface this also presents -- `store`, not
`drafts`, because `self.drafts` would shadow the drafts() method and surface as
"'dict' object is not callable" a long way from the cause.

Attachments are shown the way Gmail's drafts resource shows them: a part with a filename
carries `body.attachmentId` and `body.size` and NO bytes, and the bytes come from a second
call, `users().messages().attachments().get`. That is Gmail's documented shape; it has not
yet been seen on a real draft (see mail-ai's plan).
"""

from __future__ import annotations

import base64
import email
import mimetypes
from typing import Any


def _b64(data: bytes) -> str:
    """Gmail's base64url, with the padding stripped."""
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class _Request:
    def __init__(self, payload: Any = None, error: Exception | None = None) -> None:
        self._payload = payload
        self._error = error

    def execute(self) -> Any:
        if self._error is not None:
            raise self._error
        return self._payload


def _payload_for(to: str, subject: str, body: str) -> dict[str, Any]:
    return {
        "mimeType": "text/plain",
        "headers": [
            {"name": "To", "value": to},
            {"name": "Subject", "value": subject},
        ],
        "body": {"data": _b64(body.encode())},
    }


class FakeDrafts:
    def __init__(self) -> None:
        self.store: dict[str, dict[str, Any]] = {}
        self.sent: list[str] = []
        self._next = 1
        self._blobs: dict[str, bytes] = {}   # attachment id -> its bytes
        self._owner: dict[str, str] = {}     # attachment id -> the message it hangs off
        self._next_blob = 1
        # How the second call behaves: "ok", "fails" (an error) or "short" (one byte missing).
        self.fetch_mode = "ok"

    def users(self):
        return self

    def drafts(self):
        return _Drafts(self)

    def messages(self):
        return _Messages(self)

    def add(self, to: str, subject: str, body: str, thread_id: str = "",
            files: list[tuple[str, bytes, str]] | tuple = ()) -> str:
        """`files` are (filename, bytes, mime type) triples."""
        draft_id = f"d{self._next}"
        self._next += 1
        self.store[draft_id] = {
            "id": draft_id,
            "message": {
                "id": f"m-{draft_id}",
                "threadId": thread_id,
                "payload": _payload_for(to, subject, body),
            },
        }
        for filename, data, mime_type in files:
            self.attach(draft_id, filename, data, mime_type)
        return draft_id

    def edit(self, draft_id: str, to: str, subject: str, body: str) -> None:
        """Change a draft in place, exactly as a person editing it in Gmail would. Anything
        attached is gone, as it is when the whole message is replaced."""
        self.store[draft_id]["message"]["payload"] = _payload_for(to, subject, body)

    # -- attachments: each of these is an edit a person could make in Gmail --------------

    def _payload(self, draft_id: str) -> dict[str, Any]:
        return self.store[draft_id]["message"]["payload"]

    def _file_part(self, draft_id: str, filename: str) -> dict[str, Any]:
        for part in self._payload(draft_id).get("parts", []):
            if part.get("filename") == filename:
                return part
        raise KeyError(f"no attachment {filename} on {draft_id}")

    def _new_blob(self, draft_id: str, data: bytes) -> str:
        blob_id = f"att{self._next_blob}"
        self._next_blob += 1
        self._blobs[blob_id] = data
        self._owner[blob_id] = self.store[draft_id]["message"]["id"]
        return blob_id

    def attach(self, draft_id: str, filename: str, data: bytes, mime_type: str = "") -> None:
        payload = self._payload(draft_id)
        if not payload.get("parts"):
            # A single-part draft becomes multipart/mixed, its old body the first part.
            payload["parts"] = [{"mimeType": payload["mimeType"], "body": payload["body"]}]
            payload["mimeType"] = "multipart/mixed"
            payload["body"] = {"size": 0}
        guessed = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        payload["parts"].append({
            "mimeType": mime_type or guessed,
            "filename": filename,
            "body": {"attachmentId": self._new_blob(draft_id, data), "size": len(data)},
        })

    def drop_attachment(self, draft_id: str, filename: str) -> None:
        self._payload(draft_id)["parts"].remove(self._file_part(draft_id, filename))

    def replace_attachment(self, draft_id: str, filename: str, data: bytes) -> None:
        part = self._file_part(draft_id, filename)
        part["body"] = {"attachmentId": self._new_blob(draft_id, data), "size": len(data)}

    def rename_attachment(self, draft_id: str, old: str, new: str) -> None:
        self._file_part(draft_id, old)["filename"] = new


class _Drafts:
    def __init__(self, gmail: FakeDrafts) -> None:
        self.gmail = gmail

    def create(self, userId: str, body: dict):  # noqa: N803
        parsed = email.message_from_bytes(base64.urlsafe_b64decode(body["message"]["raw"]))
        text = ""
        files: list[tuple[str, bytes, str]] = []
        if parsed.is_multipart():
            for part in parsed.walk():
                if part.is_multipart():
                    continue
                name = part.get_filename()
                if name:
                    files.append((name, part.get_payload(decode=True), part.get_content_type()))
                elif part.get_content_type() == "text/plain" and not text:
                    text = part.get_payload(decode=True).decode()
        else:
            text = parsed.get_payload(decode=True).decode()
        draft_id = self.gmail.add(
            parsed.get("To", ""), parsed.get("Subject", ""), text,
            body["message"].get("threadId", ""), files=files,
        )
        return _Request(self.gmail.store[draft_id])

    def get(self, userId: str, id: str, format: str = "full"):  # noqa: A002, N803
        if id not in self.gmail.store:
            raise KeyError(f"no draft {id}")
        return _Request(self.gmail.store[id])

    def list(self, userId: str, maxResults: int = 25):  # noqa: N803
        return _Request({"drafts": list(self.gmail.store.values())[:maxResults]})

    def delete(self, userId: str, id: str):  # noqa: A002, N803
        self.gmail.store.pop(id, None)
        return _Request(None)

    def send(self, userId: str, body: dict):  # noqa: N803
        draft_id = body["id"]
        self.gmail.sent.append(draft_id)
        return _Request({"id": f"sent-{draft_id}", "threadId": "t1"})


class _Messages:
    def __init__(self, gmail: FakeDrafts) -> None:
        self.gmail = gmail

    def attachments(self):
        return _Attachments(self.gmail)


class _Attachments:
    def __init__(self, gmail: FakeDrafts) -> None:
        self.gmail = gmail

    def get(self, userId: str, messageId: str, id: str):  # noqa: A002, N803
        gmail = self.gmail
        if gmail.fetch_mode == "fails":
            return _Request(error=OSError("attachment fetch failed"))
        # Gmail answers for the message an attachment belongs to and no other.
        if gmail._owner.get(id) != messageId:
            return _Request(error=KeyError(f"no attachment {id} on message {messageId}"))
        data = gmail._blobs[id]
        if gmail.fetch_mode == "short":
            data = data[:-1]
        return _Request({"size": len(data), "data": _b64(data)})
