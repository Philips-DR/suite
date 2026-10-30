"""Run what tools.yaml says to run on a timer, whether or not anyone has a page open.

The web app used to sync mail every 30 minutes from a timer in the page, so a closed tab meant a stale
mailbox: on 2026-10-24 it was five days out of date. The backend runs all the time, so the timer lives
here. Which tool and how often are in tools.yaml; this module knows neither.

A scheduled run is the person's standing order, written in tools.yaml, so it takes the path a button press
takes -- `session.execute`, the gate answered by that order -- with two differences, both because it runs
every half hour, all day:

  * It is audited when its outcome changes (the first run, a failure, a recovery), not every time. Every
    run would push a person's own actions out of the History page and the Overview's counts, as the page's
    timer did (a row every 30 minutes on 2026-10-19). The last row per tool, which Settings reads for a
    tool's health, is still the current state.
  * It is never part of the conversation or noted for the model. It speaks only when it starts failing,
    and when it recovers.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from assistant.audit import AuditStore
from assistant.session import allow_gate, execute
from assistant.tools import ToolRegistry

ORIGIN = "schedule"

Emit = Callable[[dict[str, Any]], Awaitable[None]]
Sleep = Callable[[float], Awaitable[None]]


class _OnChange:
    """The audit log, keeping a scheduled run only when its outcome differs from the last one kept."""

    def __init__(self, audit: AuditStore) -> None:
        self.audit = audit
        self.last: str | None = None

    async def record(self, **row: Any) -> None:
        if row.get("outcome") != self.last:
            self.last = row.get("outcome")
            await self.audit.record(**row)


def schedule_notice(server: str, tool: str, before: str | None, outcome: str, output: str) -> dict[str, Any] | None:
    """What to say when a scheduled run's outcome changes, or None. Pure, so it can be tested alone."""
    if outcome == "failed" and before != "failed":
        return {"level": "warning", "title": f"{server} {tool} is failing on its schedule", "body": output[:200]}
    if outcome == "ok" and before == "failed":
        return {"level": "success", "title": f"{server} {tool} is working again",
                "body": "It is running on its schedule again."}
    return None


async def run_every(registry: ToolRegistry, audit: AuditStore, emit: Emit, server: str, qualified: str,
                    seconds: float, sleep: Sleep = asyncio.sleep) -> None:
    """Run one scheduled tool now, then every `seconds` after the last run ends, until cancelled.

    A run never overlaps the one before it, and a failure never stops the timer: it is recorded, said once,
    and tried again next time."""
    log = _OnChange(audit)
    before: str | None = None
    while True:
        tool = registry.find(qualified)
        if tool is None:
            await emit({"type": "notice", "level": "error", "title": f"{qualified} is scheduled but does not exist",
                        "body": "Its schedule in tools.yaml names a tool the server does not offer."})
            return
        try:
            output, outcome = await execute(registry, tool, {}, log, allow_gate, origin=ORIGIN)  # type: ignore[arg-type]
        except asyncio.CancelledError:
            raise
        except Exception as error:  # the audit or the transport failing must not end the timer
            output, outcome = f"scheduled run failed: {error}", "failed"
        notice = schedule_notice(server, tool.name, before, outcome, output)
        before = outcome
        if notice:
            await emit({"type": "notice", **notice})
        await sleep(seconds)
