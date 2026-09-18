"""Gate bot: GPT-Live in client delegation, backend worker with webhook tools.

The shape under test is the product's shape, not a demo's:

- ``assistant.json`` is the assistant record a workspace would store: voice,
  instructions, backend instructions, a ``serverUrl``, and ``tools`` in the
  OpenAI function format.
- Every tool becomes a ``FunctionSchema`` with one shared handler that POSTs
  ``{tool, arguments, call_id}`` to ``serverUrl`` and returns the JSON body.
  Nothing about a specific tool is hard-coded.
- The voice model (``gpt-live-1``) holds no tools. It delegates; the backend
  text model picks the tool and calls the webhook.

Run ``uv run webhook.py`` in one terminal and ``uv run bot.py -t webrtc`` in
another, then open http://localhost:7860 and talk. Evidence lands in
``evidence/<session>.jsonl``; ``uv run evidence.py`` prints the verdict.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv
from loguru import logger

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    AssistantTurnStoppedMessage,
    LLMContextAggregatorPair,
    UserTurnMessageAddedMessage,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.live.llm import OpenAILiveLLMService
from pipecat.services.openai.responses.llm import OpenAIResponsesHttpLLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.workers.llm import BackendLLMWorker
from pipecat.workers.runner import WorkerRunner

from evidence import EvidenceLog, EvidenceObserver

load_dotenv(override=True)

ASSISTANT = json.loads((Path(__file__).parent / "assistant.json").read_text(encoding="utf-8"))
BACKEND_MODEL = os.environ.get("BACKEND_MODEL", "gpt-5.6-luna")
DELEGATION_TIMEOUT_SECS = float(os.environ.get("DELEGATION_TIMEOUT_SECS", "30"))


def webhook_tools(assistant: dict, log: EvidenceLog) -> list[FunctionSchema]:
    """Turn the assistant's OpenAI-format tool list into Pipecat tools that call the webhook."""
    server_url: str = assistant["serverUrl"]
    tools: list[FunctionSchema] = []

    for entry in assistant["tools"]:
        fn = entry["function"]
        name = fn["name"]

        async def call_webhook(params: FunctionCallParams, *, _name: str = name) -> None:
            call_id = getattr(params, "tool_call_id", None) or uuid.uuid4().hex[:8]
            log.record("tool_start", tool=_name, call_id=call_id, arguments=params.arguments)
            started = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=DELEGATION_TIMEOUT_SECS) as client:
                    response = await client.post(
                        server_url,
                        json={"tool": _name, "arguments": params.arguments, "call_id": call_id},
                    )
                body = response.json()
                if response.status_code != 200:
                    log.record("tool_end", tool=_name, call_id=call_id, ok=False, status=response.status_code)
                    await params.result_callback({"error": body.get("detail", f"HTTP {response.status_code}")})
                    return
                log.record(
                    "tool_end",
                    tool=_name,
                    call_id=call_id,
                    ok=True,
                    status=200,
                    elapsed_ms=round((time.monotonic() - started) * 1000),
                )
                await params.result_callback(body["result"])
            except Exception as error:  # noqa: BLE001 - the whole point is to report it honestly
                log.record("tool_end", tool=_name, call_id=call_id, ok=False, error=type(error).__name__)
                await params.result_callback({"error": f"webhook unreachable: {type(error).__name__}"})

        tools.append(
            FunctionSchema(
                name=name,
                description=fn["description"],
                properties=fn["parameters"]["properties"],
                required=fn["parameters"].get("required", []),
                handler=call_webhook,
            )
        )
    return tools


def backend_llm() -> OpenAIResponsesHttpLLMService:
    """The backend text model, called through the Responses API.

    Not the chat-completions service: current reasoning models (gpt-5.6-*) reject
    function tools on /v1/chat/completions with a 400, which the backend worker
    swallows into an empty result. Found on the first gate run.
    """
    return OpenAIResponsesHttpLLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        settings=OpenAIResponsesHttpLLMService.Settings(
            model=BACKEND_MODEL,
            system_instruction=ASSISTANT["backendInstructions"],
        ),
    )


transport_params = {
    "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True),
}


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments) -> None:
    session = time.strftime("%Y%m%d-%H%M%S")
    log = EvidenceLog(session)
    logger.info(f"Gate session {session}; evidence at {log.path}")

    backend = BackendLLMWorker(
        llm=backend_llm(),
        context=LLMContext(tools=webhook_tools(ASSISTANT, log)),
    )

    llm = OpenAILiveLLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        settings=OpenAILiveLLMService.Settings(
            system_instruction=ASSISTANT["instructions"],
            voice=ASSISTANT.get("voice"),
        ),
        delegation=OpenAILiveLLMService.ClientDelegation(
            backend=backend, timeout_secs=DELEGATION_TIMEOUT_SECS
        ),
    )

    # The live model's context carries no tools; that is the invariant under test.
    context = LLMContext([{"role": "developer", "content": "Greet the caller and ask how you can help."}])
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            user_aggregator,
            llm,
            transport.output(),
            assistant_aggregator,
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
        observers=[EvidenceObserver(log)],
        processor_unusable_policy=ProcessorUnusablePolicy.END,
    )

    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        log.record("client_connected")
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        log.record("client_disconnected")
        await runner.cancel()

    @llm.event_handler("on_delegation_created")
    async def on_delegation_created(llm, delegation):
        log.record("delegation_created", delegation_id=getattr(delegation, "id", None))

    @backend.assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def on_backend_turn_stopped(aggregator, message: AssistantTurnStoppedMessage):
        log.record("backend_result", text=message.content)

    @user_aggregator.event_handler("on_user_turn_message_added")
    async def on_user_turn(aggregator, message: UserTurnMessageAddedMessage):
        log.record("transcript_user", text=message.content)

    @assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn(aggregator, message: AssistantTurnStoppedMessage):
        log.record("transcript_assistant", text=message.content)

    try:
        await runner.run()
    finally:
        log.close()


async def bot(runner_args: RunnerArguments) -> None:
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
