"""What every front door does before the first turn: choose the stores, load memory, build the
context the model sees, and materialise the lexicon. Shared, so the terminal and the web server
cannot drift into giving the model two different views of the same user."""

from __future__ import annotations

from pathlib import Path

from assistant.audit import AuditStore, FileAuditStore, PgAuditStore
from assistant.builtins import memory_tools
from assistant.db import Database
from assistant.memory import FileMemoryStore, MemoryStore, PgMemoryStore
from assistant.tools import LocalTool


def stores_for(database: Database | None, memory_path: Path, audit_path: Path) -> tuple[MemoryStore, AuditStore]:
    """The database's stores when there is a database, the files otherwise. The database is not
    connected yet: the stores read its pool when they are used."""
    if database is None:
        return FileMemoryStore(memory_path), FileAuditStore(audit_path)
    return PgMemoryStore(database), PgAuditStore(database)


def lexicon_path_for(memory_path: Path) -> Path:
    """Beside where memory used to live, so a tool is handed the same path whichever store runs."""
    return Path(memory_path).with_name("lexicon.json")


async def context_for(store: MemoryStore | None, lexicon_path: Path) -> str:
    """What the model is told about the user, rebuilt from memory as it stands now."""
    if store is None:
        return ""
    context = await store.as_prompt_block()
    # The lexicon is derived state, rebuilt from memory every session and handed to tools
    # by path. Materialising it here rather than exposing a tool for it means no gate
    # question mid-chain, and means meet-ai still never knows a memory store exists.
    written = await store.write_lexicon(lexicon_path)
    if written:
        context += (
            f"\n\nA lexicon of correct spellings is at {written}. Pass it as the "
            f"`lexicon` argument to any tool that accepts one."
        )
    return context


async def prepare(store: MemoryStore | None, lexicon_path: Path) -> tuple[list[LocalTool], str]:
    """The built-in tools and the context for the first turn. No store means no memory at all."""
    return (memory_tools(store) if store else []), await context_for(store, lexicon_path)


async def current_lexicon(store: MemoryStore, lexicon_path: Path) -> Path | None:
    """Rebuild the lexicon from memory as it stands now, for a door that calls tools itself.

    Chat is told the lexicon's path and passes it; a button press has no model to tell, so
    the server fills it in -- otherwise a spelling taught to the assistant would correct
    transcripts written up from chat and silently not those written up from a button.
    """
    return await store.write_lexicon(lexicon_path)
