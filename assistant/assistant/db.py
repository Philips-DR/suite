"""PostgreSQL: the connection pool, the numbered migrations, and the one-time import of the old files.

Raw asyncpg and plain SQL files, on purpose -- no ORM, no Alembic. `migrations/NNN_name.sql` are
applied in name order, each once, and a file that has been applied is never edited: a change is a new
file. The stores (memory.py, audit.py, auth.py) take a `Database` and use its pool at call time, so
one can be built before the event loop exists and connected in the server's lifespan.

Only the container setup has a database (DATABASE_URL). With none, the stores are the files they
always were, which is what the tests use.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
# Held while migrations run, so two backends starting together cannot both apply the same file.
MIGRATION_LOCK = 7_309_001

log = logging.getLogger("assistant.db")


class Database:
    """A pool, connected on demand. Async context manager: entering connects, leaving closes."""

    def __init__(self, url: str, legacy_memory: Path | None = None, legacy_audit: Path | None = None) -> None:
        self.url = url
        # The flat files this database replaces. Imported once, on connect, if they exist.
        self.legacy_memory = legacy_memory
        self.legacy_audit = legacy_audit
        self.imported: dict[str, int] = {}
        self._pool: Any = None

    @property
    def pool(self) -> Any:
        if self._pool is None:
            raise RuntimeError("the database is not connected")
        return self._pool

    async def connect(self) -> None:
        # Imported here so every other module stays importable, and testable, without a driver.
        import asyncpg

        self._pool = await asyncpg.create_pool(self.url, min_size=1, max_size=5)
        try:
            await migrate(self._pool)
            self.imported = await import_legacy_files(self._pool, self.legacy_memory, self.legacy_audit)
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        pool, self._pool = self._pool, None
        if pool is not None:
            await pool.close()

    async def __aenter__(self) -> "Database":
        await self.connect()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()


async def migrate(pool: Any, directory: Path = MIGRATIONS) -> list[str]:
    """Apply every migration file not yet applied. Returns the names it applied."""
    applied: list[str] = []
    async with pool.acquire() as conn:
        await conn.execute("SELECT pg_advisory_lock($1)", MIGRATION_LOCK)
        try:
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS migrations ("
                "name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
            done = {row["name"] for row in await conn.fetch("SELECT name FROM migrations")}
            for path in sorted(directory.glob("*.sql")):
                if path.name in done:
                    continue
                # One transaction per file: a migration that fails half-way leaves nothing behind
                # and is not recorded, so the next start tries it again.
                async with conn.transaction():
                    await conn.execute(path.read_text(encoding="utf-8"))
                    await conn.execute("INSERT INTO migrations (name) VALUES ($1)", path.name)
                applied.append(path.name)
        finally:
            await conn.execute("SELECT pg_advisory_unlock($1)", MIGRATION_LOCK)
    return applied


# ---------------------------------------------------------------------------
# The one-time import of memory.json and audit.jsonl
# ---------------------------------------------------------------------------

def _retire(path: Path) -> Path:
    """Rename an imported file out of the way, without overwriting an earlier one."""
    target = path.with_name(path.name + ".imported")
    n = 1
    while target.exists():
        n += 1
        target = path.with_name(f"{path.name}.imported.{n}")
    path.rename(target)
    return target


def _fact_rows(path: Path) -> list[tuple[str, str, str, str, date]]:
    from assistant.memory import KINDS  # here, not at the top: memory.py does not import this module

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = []
    for entry in raw.get("facts", []):
        if not entry.get("subject") or not entry.get("id"):
            continue  # the file store skipped these on load too
        kind = str(entry.get("kind", "fact"))
        try:
            created = date.fromisoformat(str(entry.get("created", "")))
        except ValueError:
            created = date.today()
        # A hand-edited file may hold a kind the database refuses; keep the fact rather than lose it.
        rows.append((str(entry["id"]), kind if kind in KINDS else "fact",
                     str(entry["subject"]), str(entry.get("content", "")), created))
    return rows


def _audit_rows(path: Path) -> tuple[list[tuple[Any, ...]], int]:
    rows: list[tuple[Any, ...]] = []
    skipped = 0
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return [], 0
    for line in lines:
        try:
            row = json.loads(line)
            at = datetime.fromisoformat(row["at"])
            tool, outcome = str(row["tool"]), str(row["outcome"])
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            skipped += 1  # one corrupt line must not hide the rest
            continue
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        rows.append((at, tool, row.get("arguments"), outcome, row.get("error"),
                     row.get("duration_ms"), row.get("result"), row.get("origin")))
    return rows, skipped


async def import_legacy_files(pool: Any, memory_path: Path | None, audit_path: Path | None) -> dict[str, int]:
    """Move memory.json and audit.jsonl into the database, then rename each to `.imported`.

    Safe to run again: facts merge by id, and the audit log is imported only into an empty table, so a
    file that could not be renamed is not imported twice. A file is renamed only after its rows are
    committed, so a failure here loses nothing. Returns what it imported, for the startup message.
    """
    imported: dict[str, int] = {}

    if memory_path is not None and memory_path.is_file():
        rows = _fact_rows(memory_path)
        async with pool.acquire() as conn:
            before = await conn.fetchval("SELECT count(*) FROM facts")
            async with conn.transaction():
                await conn.executemany(
                    "INSERT INTO facts (id, kind, subject, content, created_at) "
                    "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING", rows)
            imported["facts"] = await conn.fetchval("SELECT count(*) FROM facts") - before
        _retire(memory_path)

    if audit_path is not None and audit_path.is_file():
        rows, skipped = _audit_rows(audit_path)
        async with pool.acquire() as conn:
            async with conn.transaction():
                if not await conn.fetchval("SELECT EXISTS (SELECT 1 FROM audit_log)"):
                    await conn.executemany(
                        "INSERT INTO audit_log (logged_at, tool, arguments, outcome, error, duration_ms, "
                        "result, origin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", rows)
                    imported["audit"] = len(rows)
                    imported["audit_skipped"] = skipped
                else:
                    log.warning("%s was left alone: the audit log in the database already has rows", audit_path)
                    return imported
        _retire(audit_path)

    return imported
