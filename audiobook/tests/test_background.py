"""Background jobs, against real stand-in processes: no model, no Docling, no audio.

Each test launches a tiny shell script in place of `python -m audiobook ...`, inside the same
wrapper the real jobs run in, so what is exercised is the real thing: the wrapper's exit marker,
the /proc check, and the progress read back from a log.
"""

import os
import signal
import time
from pathlib import Path

import pytest

from audiobook import background
from audiobook.background import JOB_MARKER, ROOT, WRAPPER, JobError


@pytest.fixture(autouse=True)
def quick_confirm(monkeypatch):
    # start() waits this long to catch a job that dies at once; the tests need not wait 2 s each.
    monkeypatch.setattr(background, "START_CONFIRM_SECONDS", 0.3)


def standin(script: str, target: str = "book.pdf") -> list[str]:
    # "audiobook" and the target are in the real process's arguments too: python -u -m audiobook render <pdf>
    return ["bash", "-c", WRAPPER, JOB_MARKER, "bash", "-c", script, "standin", "audiobook", target]


def wait_until_finished(jobs_dir, job, seconds=10.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        job = background.get(jobs_dir, job.id)
        if job.state != "running":
            return job
        time.sleep(0.1)
    raise AssertionError(f"still {job.state} after {seconds} s")


PROGRESS = r"printf '  [ 40%%] chapter 2: A Long Title %20s 12/30 · ~0:05:00 left   \r' ''"


def test_a_finished_job_reports_done_and_what_it_made(tmp_path):
    script = PROGRESS + r"; echo; echo '  -> output/book/01-a-0.95x.mp3 (0:00:10)'; echo 'Audiobook: output/book/book.m4b'"
    job = background.start("render", "book.pdf", tmp_path, [], command=standin(script))
    job = wait_until_finished(tmp_path, job)
    assert (job.state, job.phase, job.percent, job.eta) == ("done", "done", 100.0, None)
    assert job.outputs == [str(ROOT / "output/book/01-a-0.95x.mp3"), str(ROOT / "output/book/book.m4b")]


def test_a_failed_job_says_why(tmp_path):
    job = background.start("render", "book.pdf", tmp_path, [], command=standin("echo 'it broke'; exit 3"))
    job = wait_until_finished(tmp_path, job)
    assert job.state == "failed"
    assert "it broke" in job.detail


def test_a_running_job_reports_its_progress_and_only_one_runs_at_a_time(tmp_path):
    job = background.start("render", "book.pdf", tmp_path, [], command=standin(PROGRESS + "; sleep 30"))
    try:
        job = background.get(tmp_path, job.id)
        assert job.state == "running"
        assert (job.phase, job.percent, job.chapter, job.chunks_done, job.chunks_total, job.eta) == (
            "rendering", 40.0, 2, 12, 30, "0:05:00")
        assert job.chapter_title == "A Long Title"
        with pytest.raises(JobError, match="One at a time"):
            background.start("analyse", "other.pdf", tmp_path, [], command=standin("sleep 30", "other.pdf"))
        assert background.current(tmp_path).id == job.id
    finally:
        os.killpg(job.pid, signal.SIGKILL)


def test_a_killed_job_is_interrupted_not_failed(tmp_path):
    job = background.start("render", "book.pdf", tmp_path, [], command=standin("sleep 30"))
    os.killpg(job.pid, signal.SIGKILL)
    job = wait_until_finished(tmp_path, job)
    assert job.state == "interrupted"
    assert "resumes" in job.detail
    # And a new job may now start: an interrupted one is not "running".
    again = background.start("render", "book.pdf", tmp_path, [], command=standin("sleep 30"))
    os.killpg(again.pid, signal.SIGKILL)


def test_a_job_that_dies_at_once_is_reported_in_the_start_call(tmp_path):
    job = background.start("render", "book.pdf", tmp_path, [], command=standin("echo nope; exit 2"))
    assert job.state == "failed"


def test_latest_and_get(tmp_path):
    assert background.latest(tmp_path) is None
    with pytest.raises(JobError, match="no audiobook job"):
        background.get(tmp_path, "nope")
    job = background.start("analyse", "book.pdf", tmp_path, [], command=standin("exit 0"))
    wait_until_finished(tmp_path, job)
    assert background.latest(tmp_path).id == job.id


def test_a_pid_that_is_not_our_job_is_not_believed():
    assert not background.is_our_job(None, "book.pdf")
    assert not background.is_our_job(os.getpid(), "book.pdf")  # alive, but not a job
    assert not background.is_our_job(2**22 + 12345, "book.pdf")  # not alive


def test_progress_is_read_from_each_kind_of_log():
    assert background.read_progress("analyse", "Analysing book.pdf ...")["phase"] == "analysing"
    assert background.read_progress("render", "")["phase"] == "starting"
    assert background.read_progress("render", "Loading Pocket TTS...")["phase"] == "loading the voice model"
    assert background.read_progress("sample", "")["phase"] == "speaking a sample"
    cloning = background.read_progress("voice", "  window 1/4: 0-30 s\n  window 3/4: 30-60 s")
    assert cloning["percent"] == 75
    # The LAST update wins: a render line is rewritten in place with carriage returns.
    log = "  [ 10%] chapter 1: One    3/30   \r  [ 20%] chapter 1: One    6/30 · ~1:00:00 left   \r"
    latest = background.read_progress("render", log)
    assert (latest["percent"], latest["chunks_done"], latest["eta"]) == (20.0, 6, "1:00:00")


def test_an_old_interrupted_job_never_becomes_the_latest(tmp_path):
    """Polling refreshes every job. An interrupted one used to be re-saved each time, which moved
    its file's timestamp, and `latest` sorted by timestamp: the oldest dead job would take over
    from the newest one."""
    old = background.start("render", "old.pdf", tmp_path, [], command=standin("sleep 30", "old.pdf"))
    os.killpg(old.pid, signal.SIGKILL)
    assert wait_until_finished(tmp_path, old).state == "interrupted"
    time.sleep(1.1)  # job ids carry the second they started in
    new = background.start("analyse", "new.pdf", tmp_path, [], command=standin("exit 0", "new.pdf"))
    wait_until_finished(tmp_path, new)
    for _ in range(3):
        background.current(tmp_path)  # what every status poll does: refresh every job
        assert background.latest(tmp_path).id == new.id


def test_two_starts_at_once_cannot_both_win(tmp_path):
    import threading

    results = []

    def attempt(n):
        try:
            results.append(background.start("render", f"b{n}.pdf", tmp_path, [], command=standin("sleep 30", f"b{n}.pdf")))
        except JobError:
            results.append(None)

    threads = [threading.Thread(target=attempt, args=(n,)) for n in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    started = [r for r in results if r]
    try:
        assert len(started) == 1, f"{len(started)} jobs started"
    finally:
        for job in started:
            os.killpg(job.pid, signal.SIGKILL)


def test_a_chapter_title_containing_a_fraction_is_not_read_as_progress():
    """The counts are the ones followed by the time left or the end of the line, not the first
    'N/M' the title happens to contain."""
    line = "  [ 40%] chapter 2: Part 2/3 Notes                        12/30 · ~0:05:00 left   \r"
    got = background.read_progress("render", line)
    assert (got["chapter_title"], got["chunks_done"], got["chunks_total"], got["eta"]) == ("Part 2/3 Notes", 12, 30, "0:05:00")
    no_eta = background.read_progress("render", "  [100%] chapter 1: Questions 1/2 and more    7/7   \n")
    assert (no_eta["chapter_title"], no_eta["chunks_done"], no_eta["chunks_total"]) == ("Questions 1/2 and more", 7, 7)


def test_a_job_that_finishes_between_the_checks_is_not_called_interrupted(tmp_path, monkeypatch):
    """The process must be asked about BEFORE its log is read. If it exits after the log was read
    but before it is asked about, a finished job has no exit line yet looks gone."""
    job = background.start("render", "book.pdf", tmp_path, [], command=standin("sleep 0.5; echo done"))
    order = []
    real_alive, real_read = background.is_our_job, background.Path.read_text

    def alive(*args):
        order.append("asked")
        return real_alive(*args)

    def read(self, *args, **kwargs):
        if self.suffix == ".log":
            order.append("read log")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(background, "is_our_job", alive)
    monkeypatch.setattr(background.Path, "read_text", read)
    background.refresh(tmp_path, background.Job(**{**job.__dict__, "state": "running"}))
    assert order.index("asked") < order.index("read log")
    wait_until_finished(tmp_path, job)


# ---------------------------------------------------------------------------
# Cancelling
# ---------------------------------------------------------------------------

def test_cancelling_stops_the_whole_job_and_says_what_was_kept(tmp_path):
    # A grandchild, like ffmpeg under the real render: it must die too. Its pid is written down so
    # the check is on that process, not on a name some other process might share.
    child = tmp_path / "grandchild.pid"
    job = background.start("render", "book.pdf", tmp_path, [],
                           command=standin(f"sleep 31 & echo $! > {child}; wait", "book.pdf"))
    assert background.get(tmp_path, job.id).state == "running"
    deadline = time.monotonic() + 5
    while not child.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    grandchild = int(child.read_text())
    assert Path(f"/proc/{grandchild}").exists()

    stopped = background.cancel(tmp_path)
    assert stopped.id == job.id and stopped.state == "cancelled"
    assert "already spoken is kept" in stopped.detail
    assert not background.is_our_job(job.pid, "book.pdf")
    # Nothing in the job's process group is left burning CPU. (It may take a moment to be reaped.)
    deadline = time.monotonic() + 2
    while Path(f"/proc/{grandchild}").exists() and time.monotonic() < deadline:
        stat = Path(f"/proc/{grandchild}/stat").read_text().rsplit(")", 1)[-1].split()[0]
        if stat == "Z":  # dead, waiting to be reaped by whoever adopted it
            break
        time.sleep(0.05)
    else:
        assert not Path(f"/proc/{grandchild}").exists(), "the grandchild is still running"

    # It is final, it is not "interrupted" however often it is polled, and a new job may start.
    for _ in range(3):
        assert background.get(tmp_path, job.id).state == "cancelled"
    assert background.current(tmp_path) is None
    again = background.start("render", "book.pdf", tmp_path, [], command=standin("sleep 30", "book.pdf"))
    os.killpg(again.pid, signal.SIGKILL)


def test_what_is_kept_depends_on_what_was_cancelled(tmp_path):
    for kind, expected in (("analyse", "begins again"), ("voice", "was not saved")):
        job = background.start(kind, "x", tmp_path, [], command=standin("sleep 30", "x"))
        assert expected in background.cancel(tmp_path, job.id).detail


def test_cancelling_when_nothing_runs_or_twice_is_an_error_not_a_crash(tmp_path):
    with pytest.raises(JobError, match="nothing is running"):
        background.cancel(tmp_path)
    job = background.start("render", "book.pdf", tmp_path, [], command=standin("sleep 30", "book.pdf"))
    background.cancel(tmp_path)
    with pytest.raises(JobError, match="already cancelled"):
        background.cancel(tmp_path, job.id)
    with pytest.raises(JobError, match="no audiobook job"):
        background.cancel(tmp_path, "nope")


def test_a_job_that_stops_ignoring_the_polite_request_is_still_stopped(tmp_path, monkeypatch):
    monkeypatch.setattr(background, "STOP_WAIT_SECONDS", 0.5)
    """Everything below the wrapper ignores SIGTERM, so the wrapper dies at once and the job's own
    process does not. A cancel that watched only the wrapper would call this stopped."""
    child = tmp_path / "stubborn.pid"
    stubborn = standin(f"trap '' TERM; sleep 31 & echo $! > {child}; wait", "book.pdf")
    job = background.start("render", "book.pdf", tmp_path, [], command=stubborn)
    deadline = time.monotonic() + 5
    while not child.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    grandchild = int(child.read_text())
    assert background.cancel(tmp_path).state == "cancelled"
    assert not background._group_alive(job.pid), "something in the job's group survived the cancel"
    assert not Path(f"/proc/{grandchild}").exists() or \
        Path(f"/proc/{grandchild}/stat").read_text().rsplit(")", 1)[-1].split()[0] == "Z"


def test_a_job_that_finished_before_the_cancel_landed_is_done_not_cancelled(tmp_path):
    """The marker is written before the kill. If the job had in fact already finished -- its exit
    line is in the log -- that is the truth, and it must win."""
    log = tmp_path / "j1.log"
    log.write_text("  -> output/b/01.mp3 (0:00:10)\n\n[exit 0]\n")
    job = background.Job(id="j1", kind="render", target="book.pdf", log=str(log), started_at="now", pid=None)
    background._cancel_marker(tmp_path, "j1").write_text("now")
    assert background.refresh(tmp_path, job).state == "done"


def test_killing_only_the_wrapper_does_not_make_a_running_job_look_interrupted(tmp_path):
    """The render underneath keeps going. "Interrupted" would invite starting a second one beside it."""
    # `; true` keeps a shell around the sleep, as `python -m audiobook render <pdf>` is a process that
    # names its book: without it bash would exec straight into `sleep`, which names nothing.
    command = standin("sleep 31; true", "book.pdf")
    job = background.start("render", "book.pdf", tmp_path, [], command=command)
    try:
        os.kill(job.pid, signal.SIGKILL)  # just the wrapper, not its group
        time.sleep(0.3)
        assert background.get(tmp_path, job.id).state == "running"
        with pytest.raises(JobError, match="One at a time"):
            background.start("render", "book.pdf", tmp_path, [], command=command)
        assert background.cancel(tmp_path).state == "cancelled"
        assert not background._group_alive(job.pid)
    finally:
        try:
            os.killpg(job.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
