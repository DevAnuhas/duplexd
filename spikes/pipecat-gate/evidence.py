"""Timestamped evidence for the gate.

Every event is one JSON line in ``evidence/<session>.jsonl`` with a monotonic
``t`` in seconds since the bot started. The verdict is read off the file, not
off anyone's impression of the call: a ``bot_speaking_start`` between a
``tool_start`` and its ``tool_end`` is the model talking while the webhook runs.

Two sources feed it. The observer sees the main pipeline's frames, which is
where the output transport reports bot speech. The tool handler in ``bot.py``
records tool start/end itself, because the backend worker runs in its own
pipeline and its frames do not pass the main pipeline's observers.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    TranscriptionFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed

EVIDENCE_DIR = Path(__file__).parent / "evidence"


class EvidenceLog:
    def __init__(self, session: str) -> None:
        EVIDENCE_DIR.mkdir(exist_ok=True)
        self.path = EVIDENCE_DIR / f"{session}.jsonl"
        self._t0 = time.monotonic()
        self._file = self.path.open("a", encoding="utf-8")
        self.record("session_start", session=session)

    def record(self, event: str, **fields: object) -> None:
        line = {"t": round(time.monotonic() - self._t0, 3), "event": event, **fields}
        self._file.write(json.dumps(line) + "\n")
        self._file.flush()

    def close(self) -> None:
        self.record("session_end")
        self._file.close()


class EvidenceObserver(BaseObserver):
    """Writes bot speech, interruptions, and user transcriptions to the log."""

    def __init__(self, log: EvidenceLog) -> None:
        super().__init__()
        self._log = log
        self._seen: set[int] = set()

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        # The same frame is pushed once per processor hop, so the observer sees
        # it many times. Record each frame once.
        if frame.id in self._seen:
            return
        self._seen.add(frame.id)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._log.record("bot_speaking_start")
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._log.record("bot_speaking_stop")
        elif isinstance(frame, InterruptionFrame):
            self._log.record("interruption")
        elif isinstance(frame, TranscriptionFrame):
            self._log.record("user_transcript", text=frame.text)


def verdict(path: Path) -> dict:
    """Read one evidence file and decide whether the model spoke during each tool call."""
    events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    tools = [e for e in events if e["event"] == "tool_start"]
    speech_starts = [e["t"] for e in events if e["event"] == "bot_speaking_start"]
    rows = []
    for start in tools:
        end = next(
            (e for e in events if e["event"] == "tool_end" and e.get("call_id") == start.get("call_id")),
            None,
        )
        if end is None:
            rows.append({"tool": start["tool"], "call_id": start.get("call_id"), "spoke_during": None, "note": "no tool_end"})
            continue
        during = [t for t in speech_starts if start["t"] < t < end["t"]]
        rows.append(
            {
                "tool": start["tool"],
                "call_id": start.get("call_id"),
                "webhook_secs": round(end["t"] - start["t"], 2),
                "ok": end.get("ok"),
                "spoke_during": bool(during),
                "speech_starts_during": during,
            }
        )
    return {"file": str(path), "tool_calls": rows, "interruptions": sum(1 for e in events if e["event"] == "interruption")}


if __name__ == "__main__":
    import sys

    files = [Path(p) for p in sys.argv[1:]] or sorted(EVIDENCE_DIR.glob("*.jsonl"))
    for f in files:
        print(json.dumps(verdict(f), indent=2))
