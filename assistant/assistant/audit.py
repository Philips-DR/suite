"""Append-only record of everything the assistant did.

One row per tool invocation. With tools behind MCP each call is a discrete, typed event
rather than a function call buried in a process, which is what makes "what did it get wrong
this week" answerable from the log alone.

A JSON-lines file (tests, a bare checkout) or the audit_log table (the containers). Both hand rows
back in the same shape, so the web app cannot tell which it is reading.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from assistant.db import Database

SUMMARY_LIMIT = 400

log = logging.getLogger("assistant.audit")


def _summarise(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text[:SUMMARY_LIMIT]


def _stamped(fields: dict[str, Any]) -> dict[str, Any]:
    row = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **fields}
    for key in ("arguments", "result"):
        if key in row:
            row[key] = _summarise(row[key])
    return row


def server_of(row: dict[str, Any]) -> str:
    """The tool server a row belongs to: `docu_ai__build` -> `docu_ai`."""
    return str(row.get("tool", "")).split("__", 1)[0]


class AuditStore(ABC):
    @abstractmethod
    async def record(self, **fields: Any) -> None:
        """Add one row. Never raises: a broken log must not break the work."""

    @abstractmethod
    async def recent(self, limit: int) -> list[dict[str, Any]]:
        """The newest `limit` rows, newest first."""

    @abstractmethod
    async def last_by_server(self) -> dict[str, dict[str, Any]]:
        """The latest row of each tool server, by server name."""


class FileAuditStore(AuditStore):
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    async def record(self, **fields: Any) -> None:
        row = _stamped(fields)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def _lines(self) -> list[str]:
        try:
            return self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []

    async def recent(self, limit: int) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for line in reversed(self._lines()[-limit:]):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # one corrupt line must not hide the rest
        return rows

    async def last_by_server(self) -> dict[str, dict[str, Any]]:
        last: dict[str, dict[str, Any]] = {}
        for line in self._lines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            last[server_of(row)] = row  # the file is in time order, so the last one wins
        return last


_COLUMNS = "logged_at, tool, arguments, outcome, error, duration_ms, result, origin"


def _row_of(record) -> dict[str, Any]:
    row = {"at": record["logged_at"].astimezone(timezone.utc).isoformat(timespec="seconds"),
           **{key: record[key] for key in ("tool", "arguments", "outcome", "error", "duration_ms",
                                           "result", "origin")}}
    # A call that had nothing for a field (a declined one has no duration) simply lacks it, as in the file.
    return {key: value for key, value in row.items() if value is not None}


class PgAuditStore(AuditStore):
    def __init__(self, database: "Database") -> None:
        self._db = database

    async def record(self, **fields: Any) -> None:
        row = _stamped(fields)
        try:
            await self._db.pool.execute(
                f"INSERT INTO audit_log ({_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                datetime.fromisoformat(row["at"]), row["tool"], row.get("arguments"), row["outcome"],
                row.get("error"), row.get("duration_ms"), row.get("result"), row.get("origin"))
        except Exception:
            log.warning("an audit row could not be written", exc_info=True)

    async def recent(self, limit: int) -> list[dict[str, Any]]:
        try:
            records = await self._db.pool.fetch(
                f"SELECT {_COLUMNS} FROM audit_log ORDER BY logged_at DESC, id DESC LIMIT $1", limit)
        except Exception:
            log.warning("the audit log could not be read", exc_info=True)
            return []
        return [_row_of(r) for r in records]

    async def last_by_server(self) -> dict[str, dict[str, Any]]:
        try:
            records = await self._db.pool.fetch(
                f"SELECT DISTINCT ON (split_part(tool, '__', 1)) {_COLUMNS} FROM audit_log "
                "ORDER BY split_part(tool, '__', 1), logged_at DESC, id DESC")
        except Exception:
            log.warning("the audit log could not be read", exc_info=True)
            return {}
        rows = [_row_of(r) for r in records]
        return {server_of(row): row for row in rows}
