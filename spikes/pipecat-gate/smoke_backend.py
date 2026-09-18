"""Drive the backend text model and webhook tools without any audio.

Proves the part of the gate that does not need a microphone: the Responses API
service accepts the assistant's tools, picks one for a transcript, calls the
webhook through the shared handler, and answers in plain speech. Runs the same
``backend_llm()`` and ``webhook_tools()`` that ``bot.py`` uses.

Run ``uv run webhook.py`` first, then ``uv run smoke_backend.py``.
"""

from __future__ import annotations

import asyncio
import json
import sys

from pipecat.frames.frames import EndFrame, LLMMessagesAppendFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    AssistantTurnStoppedMessage,
    LLMContextAggregatorPair,
)
from pipecat.workers.runner import WorkerRunner

from bot import ASSISTANT, backend_llm, webhook_tools
from evidence import EvidenceLog

TRANSCRIPT = (
    "Recent voice conversation:\n"
    "user: Hi, can you look up my latest invoice? My email is kevin at boring host dot ai.\n"
    "assistant: Sure, checking that now."
)


async def main() -> int:
    log = EvidenceLog("smoke-backend")
    llm = backend_llm()
    context = LLMContext(tools=webhook_tools(ASSISTANT, log))
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)
    pipeline = Pipeline([user_aggregator, llm, assistant_aggregator])
    worker = PipelineWorker(pipeline, params=PipelineParams())
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    answers: list[str] = []
    done = asyncio.Event()

    @assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def on_turn(aggregator, message: AssistantTurnStoppedMessage):
        text = (message.content or "").strip()
        if text:
            answers.append(text)
            log.record("backend_result", text=text)
        if not assistant_aggregator.has_function_calls_in_progress and answers:
            done.set()

    await worker.queue_frames(
        [LLMMessagesAppendFrame(messages=[{"role": "user", "content": TRANSCRIPT}], run_llm=True)]
    )
    run = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(done.wait(), timeout=60)
    except asyncio.TimeoutError:
        print("FAIL: no final answer within 60 s")
    await worker.queue_frames([EndFrame()])
    await asyncio.wait_for(run, timeout=15)
    log.close()

    events = [json.loads(l) for l in log.path.read_text().splitlines() if l.strip()]
    tools = [e for e in events if e["event"] in ("tool_start", "tool_end")]
    print("tool events:", json.dumps(tools, indent=1))
    print("final answer:", answers[-1] if answers else None)
    ok = any(e["event"] == "tool_end" and e.get("ok") for e in tools) and bool(answers)
    print("SMOKE", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
