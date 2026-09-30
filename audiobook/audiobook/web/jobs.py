"""Background jobs for the web app: one at a time, since analysing, cloning and rendering all
compete for the same CPU. Jobs report progress through an `update` callback."""

import itertools
import queue
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from typing import Any, Callable


@dataclass
class Job:
    id: int
    kind: str  # "analyse", "render", "voice-add", "voice-test"
    label: str
    status: str = "queued"  # queued, running, done, error
    progress: float = 0.0
    message: str = ""
    seconds_left: float | None = None
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


Update = Callable[..., None]  # update(progress=?, message=?, seconds_left=?, **result_fields)


class JobQueue:
    def __init__(self):
        self.jobs: dict[int, Job] = {}
        self._ids = itertools.count(1)
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        threading.Thread(target=self._worker, daemon=True).start()

    def submit(self, kind: str, label: str, fn: Callable[[Update], dict | None]) -> Job:
        job = Job(next(self._ids), kind, label)
        with self._lock:
            self.jobs[job.id] = job
        self._queue.put((job, fn))
        return job

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self.jobs.values(), key=lambda j: -j.id)

    def _worker(self) -> None:
        while True:
            job, fn = self._queue.get()
            job.status = "running"

            def update(progress=None, message=None, seconds_left=None, **result):
                if progress is not None:
                    job.progress = progress
                if message is not None:
                    job.message = message
                job.seconds_left = seconds_left
                job.result.update(result)

            try:
                job.result.update(fn(update) or {})
                job.status, job.progress, job.seconds_left = "done", 1.0, None
            except Exception as e:  # shown to the user in the jobs panel
                job.status, job.error = "error", f"{type(e).__name__}: {e}"
                traceback.print_exc()
            job.finished = time.time()
