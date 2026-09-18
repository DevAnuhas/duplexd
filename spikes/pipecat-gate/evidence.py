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

    # Speech intervals. The transport emits each speaking frame twice (once per
    # direction), so collapse starts and stops that land within 50 ms.
    def collapse(kind: str) -> list[float]:
        out: list[float] = []
        for e in events:
            if e["event"] == kind and (not out or e["t"] - out[-1] > 0.05):
                out.append(e["t"])
        return out

    starts, stops = collapse("bot_speaking_start"), collapse("bot_speaking_stop")
    intervals = []
    for s in starts:
        stop = next((x for x in stops if x > s), None)
        intervals.append((s, stop if stop is not None else float("inf")))

    rows = []
    for start in tools:
        end = next(
            (e for e in events if e["event"] == "tool_end" and e.get("call_id") == start.get("call_id")),
            None,
        )
        if end is None:
            rows.append({"tool": start["tool"], "call_id": start.get("call_id"), "note": "no tool_end"})
            continue
        t0, t1 = start["t"], end["t"]
        overlapping = [(s, e) for s, e in intervals if s < t1 and e > t0]
        started_inside = [s for s, _ in intervals if t0 < s < t1]
        spoken = sum(min(e, t1) - max(s, t0) for s, e in overlapping)
        # First speech after the webhook returned: the relay latency the caller feels.
        relay_start = next((s for s, _ in intervals if s >= t1), None)
        rows.append(
            {
                "tool": start["tool"],
                "call_id": start.get("call_id"),
                "ok": end.get("ok"),
                "webhook_secs": round(t1 - t0, 2),
                "speaking_overlapped_wait": bool(overlapping),
                "speech_started_inside_wait": bool(started_inside),
                "spoken_secs_during_wait": round(spoken, 2),
                "silent_secs_during_wait": round(max(0.0, (t1 - t0) - spoken), 2),
                "relay_latency_secs": None if relay_start is None else round(relay_start - t1, 2),
            }
        )
    return {"file": str(path), "tool_calls": rows, "interruptions": sum(1 for e in events if e["event"] == "interruption")}


if __name__ == "__main__":
    import sys

    files = [Path(p) for p in sys.argv[1:]] or sorted(EVIDENCE_DIR.glob("*.jsonl"))
    for f in files:
        print(json.dumps(verdict(f), indent=2))
