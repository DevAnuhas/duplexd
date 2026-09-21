"""Pipecat runner entry point for the duplexd agent image."""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable

from loguru import logger
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.daily.transport import DailyParams

from duplexd_agent.config import RunnerInput
from duplexd_agent.contract_probe import parse_contract_probe, run_contract_probe
from duplexd_agent.egress import Connector, EgressPolicy
from duplexd_agent.errors import AgentStartupError
from duplexd_agent.platform import PlatformClient
from duplexd_agent.provider import (
    Probe,
    ResponsesToolProbe,
    build_backend_service,
    build_model_stack,
)
from duplexd_agent.reporting import EventReporter
from duplexd_agent.runtime import run_call
from duplexd_agent.tools import SharedToolHandler, build_tools
from duplexd_agent.webhooks import WebhookDispatcher

TransportFactory = Callable[
    [RunnerArguments, dict[str, Callable[[], TransportParams]]],
    Awaitable[BaseTransport],
]

TRANSPORT_PARAMS: dict[str, Callable[[], TransportParams]] = {
    "daily": lambda: DailyParams(audio_in_enabled=True, audio_out_enabled=True),
    "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True),
}


async def bootstrap(
    runner_args: RunnerArguments,
    *,
    platform_client_factory: Callable[[RunnerInput], PlatformClient] = PlatformClient,
    probe: Probe | None = None,
    transport_factory: TransportFactory = create_transport,
    webhook_connector: Connector | None = None,
    egress_policy: EgressPolicy | None = None,
) -> None:
    contract_probe = parse_contract_probe(runner_args.body)
    if contract_probe is not None:
        await run_contract_probe(
            runner_args,
            contract_probe,
            transport_factory=transport_factory,
            transport_params=TRANSPORT_PARAMS,
        )
        return

    runner_input = RunnerInput.from_body(runner_args.body)
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise AgentStartupError("required environment variable OPENAI_API_KEY is missing")

    async with platform_client_factory(runner_input) as platform:
        config = await platform.fetch_config()
        backend_service = build_backend_service(config, api_key)
        await (probe or ResponsesToolProbe()).verify(backend_service, config.backend_model)

        reporter = EventReporter(platform)
        dispatcher = WebhookDispatcher(
            server_url=config.server_url,
            server_secret=config.server_secret,
            call_id=runner_input.call_id,
            assistant_id=config.assistant_id,
            timeout_secs=config.webhook_timeout_secs,
            egress_policy=egress_policy,
            connector=webhook_connector,
        )
        tools = build_tools(config.tools, SharedToolHandler(dispatcher, reporter))
        models = build_model_stack(
            config,
            api_key,
            tools,
            backend_service=backend_service,
        )
        transport = await transport_factory(runner_args, TRANSPORT_PARAMS)
        await run_call(
            transport=transport,
            runner_args=runner_args,
            config=config,
            models=models,
            reporter=reporter,
        )


async def bot(runner_args: RunnerArguments) -> None:
    try:
        await bootstrap(runner_args)
    except AgentStartupError as error:
        logger.error("Agent startup failed: {}", error)
        raise


def main() -> None:
    from pipecat.runner.run import main as pipecat_main

    pipecat_main()


if __name__ == "__main__":
    main()
