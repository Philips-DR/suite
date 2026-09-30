import pytest

from audiobook import tts
from audiobook.voices import MAX_PROMPT_S, MIN_PROMPT_S, candidate_windows


def test_windows_are_cut_at_pauses_and_capped_at_30s():
    pauses = [float(p) for p in range(3, 290, 4)]  # a pause every 4 s
    windows = candidate_windows(286.0, pauses)
    assert len(windows) == 4
    for start, end in windows:
        assert start in [0.0] + pauses and end in pauses + [286.0]
        assert MIN_PROMPT_S <= end - start <= MAX_PROMPT_S
    assert windows[0][0] == 0.0 and windows[-1][1] > 250  # spread across the recording


def test_no_window_without_a_usable_pause():
    assert candidate_windows(100.0, [50.0]) == []


def test_resolve_voice(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, "VOICES_DIR", tmp_path)
    (tmp_path / "abigail.safetensors").write_bytes(b"")
    assert tts.resolve_voice("abigail") == str(tmp_path / "abigail.safetensors")
    assert tts.resolve_voice("alba") == "alba"
    assert tts.resolve_voice("some/clip.wav") == "some/clip.wav"
