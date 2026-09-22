"""Pipecat runner entry point for the duplexd agent image."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from uuid import uuid4

from loguru import logger
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.daily.transport import DailyParams

from duplexd_agent.config import RunnerInput, SandboxOwner
from duplexd_agent.egress import Connector, EgressPolicy
from duplexd_agent.errors import AgentStartupError, RuntimeShutdownError
from duplexd_agent.platform import PlatformClient
from duplexd_agent.provider import (
    Probe,
    ResponsesToolProbe,
    build_backend_service,
    build_model_stack,
)
from duplexd_agent.reporting import EventReporter
from duplexd_agent.runtime import SHUTDOWN_TIMEOUT_SECS, SandboxWatchdog, run_call
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
    runner_input = RunnerInput.from_body(runner_args.body)
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise AgentStartupError("required environment variable OPENAI_API_KEY is missing")

    async with platform_client_factory(runner_input) as platform:
        watchdog: SandboxWatchdog | None = None
        # Bounded even if no configuration ever arrives. No provider work precedes claim.
        async with asyncio.timeout(20.0):
            protocol = await platform.negotiate()
            if protocol == "sandbox-v1":
                session_id = runner_args.session_id
                if not session_id:
                    raise AgentStartupError("Sandbox requires the runner session identity")
                owner = SandboxOwner(sessionId=session_id, bootId=uuid4().hex)
                await platform.register(owner)
                claimed = await platform.claim_sandbox()
                config = claimed.config
                watchdog = SandboxWatchdog(platform, claimed.control)
                await watchdog.start()
            else:
                config = await platform.fetch_config()

        reporter = EventReporter(
            platform,
            evidence_transport=platform if watchdog else None,
            request_stop=watchdog.request_stop if watchdog else None,
        )
        started = time.monotonic()
        backend_closed = True  # No backend client has been constructed yet.

        def execution_allowed() -> bool:
            if watchdog is None:
                return True
            watchdog.check()
            return not watchdog.stopped.is_set()

        async def costly_work() -> None:
            nonlocal backend_closed
            if not execution_allowed():
                return
            backend_closed = False
            backend_service = build_backend_service(config, api_key)
            try:
                await (probe or ResponsesToolProbe()).verify(backend_service, config.backend_model)
                if not execution_allowed():
                    return
                dispatcher = WebhookDispatcher(
                    server_url=config.server_url,
                    server_secret=config.server_secret,
                    call_id=runner_input.call_id,
                    assistant_id=config.assistant_id,
                    timeout_secs=config.webhook_timeout_secs,
                    egress_policy=egress_policy,
                    connector=webhook_connector,
                )
                tools = build_tools(
                    config.tools,
                    SharedToolHandler(dispatcher, reporter, execution_allowed=execution_allowed),
                )
                models = build_model_stack(config, api_key, tools, backend_service=backend_service)
                transport = await transport_factory(runner_args, TRANSPORT_PARAMS)
                kwargs = {"watchdog": watchdog} if watchdog else {}
                await run_call(
                    transport=transport,
                    runner_args=runner_args,
                    config=config,
                    models=models,
                    reporter=reporter,
                    **kwargs,
                )
            finally:
                if watchdog is not None:
                    # Includes a probe cancelled before Pipecat owns the service.
                    await backend_service._client.close()
                    backend_closed = True

        if watchdog is None:
            await costly_work()
            return

        await reporter.start()
        work = asyncio.create_task(costly_work())
        stopped = asyncio.create_task(watchdog.stopped.wait())
        shutdown_unconfirmed = False

        async def cancel_work() -> None:
            nonlocal shutdown_unconfirmed
            work.cancel()
            # wait_for can exceed its deadline while waiting for cancellation.
            # Wait without issuing a second cancellation into SDK teardown.
            done, _ = await asyncio.wait({work}, timeout=SHUTDOWN_TIMEOUT_SECS)
            if not done:
                shutdown_unconfirmed = True
                # Cleanup may finish after our deadline. Consume its exception
                # without interpreting that eventual supervisor exit as a seal.
                work.add_done_callback(lambda task: None if task.cancelled() else task.exception())
                raise RuntimeShutdownError("runtime teardown exceeded its deadline")
            if not work.cancelled():
                error = work.exception()
                if error is not None:
                    raise error

        try:
            done, _ = await asyncio.wait({work, stopped}, return_when=asyncio.FIRST_COMPLETED)
            if work in done:
                try:
                    await work
                except Exception:
                    watchdog.request_stop(
                        "startup_failed" if not watchdog.ready else "pipeline_error"
                    )
                    raise
            else:
                await cancel_work()
        finally:
            stopped.cancel()
            await asyncio.gather(stopped, return_exceptions=True)
            try:
                if not work.done() and not shutdown_unconfirmed:
                    await cancel_work()
            finally:
                await watchdog.close()
                duration_secs = time.monotonic() - started
                await reporter.stop()
                if (
                    watchdog.reason is not None
                    and work.done()
                    and not shutdown_unconfirmed
                    and watchdog.runner_stopped
                    and backend_closed
                ):
                    await reporter.complete(watchdog.reason, duration_secs)


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
