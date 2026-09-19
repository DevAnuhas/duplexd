"""OpenAI model construction and the boot-time Responses tool probe."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol, cast

from openai.types.responses import FunctionToolParam
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.openai.live.llm import OpenAILiveLLMService
from pipecat.services.openai.responses.llm import OpenAIResponsesHttpLLMService
from pipecat.workers.llm import BackendLLMWorker

from duplexd_agent.config import AgentConfig
from duplexd_agent.errors import BackendProbeError
from duplexd_agent.instructions import compose_instructions

PROBE_TOOL_NAME = "duplexd_boot_probe"
PROBE_TIMEOUT_SECS = 10.0


class Probe(Protocol):
    async def verify(
        self,
        service: OpenAIResponsesHttpLLMService,
        model: str,
    ) -> None: ...


class ResponsesToolProbe:
    """Force one harmless local tool through the service's Responses client."""

    async def verify(
        self,
        service: OpenAIResponsesHttpLLMService,
        model: str,
    ) -> None:
        tool: FunctionToolParam = {
            "type": "function",
            "name": PROBE_TOOL_NAME,
            "description": "Confirm that this model supports Responses function tools.",
            "parameters": {
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"],
                "additionalProperties": False,
            },
            "strict": True,
        }
        try:
            response = await asyncio.wait_for(
                service._client.responses.create(  # noqa: SLF001 - Pipecat owns client setup
                    model=model,
                    input="Call duplexd_boot_probe with ok=true.",
                    tools=[tool],
                    tool_choice={"type": "function", "name": PROBE_TOOL_NAME},
                    max_output_tokens=64,
                    stream=False,
                ),
                timeout=PROBE_TIMEOUT_SECS,
            )
        except Exception:  # noqa: BLE001 - provider details must not reach logs
            raise BackendProbeError(f"backend model {model} rejected the tool probe") from None

        output = getattr(response, "output", None)
        if not isinstance(output, list):
            output = []
        called_expected_tool = any(
            getattr(item, "type", None) == "function_call"
            and getattr(item, "name", None) == PROBE_TOOL_NAME
            for item in output
        )
        if not called_expected_tool:
            raise BackendProbeError(f"backend model {model} did not call the probe tool")


@dataclass(frozen=True)
class ModelStack:
    backend_service: OpenAIResponsesHttpLLMService
    backend_context: LLMContext
    backend_worker: BackendLLMWorker
    voice_service: OpenAILiveLLMService
    voice_context: LLMContext


def build_backend_service(config: AgentConfig, api_key: str) -> OpenAIResponsesHttpLLMService:
    return OpenAIResponsesHttpLLMService(
        api_key=api_key,
        retry_on_timeout=False,
        function_call_timeout_secs=config.function_call_timeout_secs,
        settings=OpenAIResponsesHttpLLMService.Settings(
            model=config.backend_model,
            system_instruction=config.backend_instructions,
        ),
    )


def build_model_stack(
    config: AgentConfig,
    api_key: str,
    tools: list[FunctionSchema],
    *,
    backend_service: OpenAIResponsesHttpLLMService | None = None,
) -> ModelStack:
    backend_llm = backend_service or build_backend_service(config, api_key)
    backend_context = LLMContext(tools=cast(Any, tools))
    backend_worker = BackendLLMWorker(llm=backend_llm, context=backend_context)
    voice_service = OpenAILiveLLMService(
        api_key=api_key,
        settings=OpenAILiveLLMService.Settings(
            system_instruction=compose_instructions(
                config.instructions,
                config.accent_style,
                config.waiting_behavior,
            ),
            voice=config.voice,
        ),
        delegation=OpenAILiveLLMService.ClientDelegation(
            backend=backend_worker,
            timeout_secs=config.delegation_timeout_secs,
        ),
    )
    # Deliberately omit tools. This context is the only context the voice
    # service sees; tool schemas and their secrets stay in the backend worker.
    voice_context = LLMContext(
        [{"role": "developer", "content": "Greet the caller and ask how you can help."}]
    )
    return ModelStack(
        backend_service=backend_llm,
        backend_context=backend_context,
        backend_worker=backend_worker,
        voice_service=voice_service,
        voice_context=voice_context,
    )


def probe_tool_schema() -> dict[str, Any]:
    """Expose the probe schema for conformance tests without registering it."""

    return {
        "type": "function",
        "name": PROBE_TOOL_NAME,
        "parameters": {"type": "object", "properties": {}, "required": []},
    }
