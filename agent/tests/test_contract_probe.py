from __future__ import annotations

import base64
import hashlib
import hmac
import json
import traceback
from types import SimpleNamespace
from typing import Any, cast

import httpx
import pytest
from pipecat.runner.types import RunnerArguments
from pipecat.transports.base_transport import BaseTransport

from duplexd_agent import bot as bot_module
from duplexd_agent.contract_probe import (
    ContractProbeConfig,
    ProbeCallback,
    parse_contract_probe,
    run_contract_probe,
)
from duplexd_agent.errors import AgentStartupError


def _secret() -> str:
    return base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("=")


def _activation_secret() -> str:
    return base64.urlsafe_b64encode(b"a" * 32).decode().rstrip("=")


def _activation_environment(**overrides: str) -> dict[str, str]:
    environment = {
        "PROVIDER_CONTRACT_PROBE_ENABLED": "stage-a-provider-proof",
        "PROVIDER_CONTRACT_PROBE_RUN_ID": "run-12345678",
        "PROVIDER_CONTRACT_PROBE_CALLBACK_URL": "https://collector.example/probe-events",
        "PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET": _activation_secret(),
    }
    environment.update(overrides)
    return environment


def _probe_body(**overrides: object) -> dict[str, object]:
    probe: dict[str, object] = {
        "version": 1,
        "runId": "run-12345678",
        "caseId": "cold_start",
        "bootId": "boot-12345678",
        "mode": "register_pause_before_join",
        "callbackUrl": "https://collector.example/probe-events",
        "callbackSecret": _secret(),
    }
    probe.update(overrides)
    message = "\n".join(
        str(probe[field])
        for field in (
            "version",
            "runId",
            "caseId",
            "bootId",
            "mode",
            "callbackUrl",
            "callbackSecret",
        )
    ).encode()
    probe.setdefault(
        "activationProof",
        hmac.new(b"a" * 32, message, hashlib.sha256).hexdigest(),
    )
    return {"providerContractProbe": probe}


def _parse(body: object) -> ContractProbeConfig | None:
    return parse_contract_probe(body, environment=_activation_environment())


def _runner_args(
    body: object, *, session_id: str | None = "session-12345678", token: str | None = None
) -> RunnerArguments:
    return cast(
        RunnerArguments,
        SimpleNamespace(
            body=body,
            session_id=session_id,
            token=token,
            handle_sigint=False,
            pipeline_idle_timeout_secs=30.0,
        ),
    )


def _jwt(properties: object) -> str:
    payload = (
        base64.urlsafe_b64encode(
            json.dumps({"properties": properties}, separators=(",", ":")).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"header.{payload}.signature"


def test_probe_is_absent_unless_the_explicit_gate_is_present() -> None:
    assert parse_contract_probe(None, environment={}) is None
    assert parse_contract_probe([], environment={}) is None
    assert parse_contract_probe({}, environment={}) is None
    assert parse_contract_probe({"providerContractProbeUnrelated": {}}, environment={}) is None


def test_probe_body_is_rejected_when_out_of_band_activation_is_absent() -> None:
    with pytest.raises(AgentStartupError, match="not authorized"):
        parse_contract_probe(_probe_body(), environment={})


@pytest.mark.parametrize(
    "missing",
    [
        "PROVIDER_CONTRACT_PROBE_ENABLED",
        "PROVIDER_CONTRACT_PROBE_RUN_ID",
        "PROVIDER_CONTRACT_PROBE_CALLBACK_URL",
        "PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET",
    ],
)
def test_partial_out_of_band_activation_fails_closed(missing: str) -> None:
    environment = _activation_environment()
    del environment[missing]
    with pytest.raises(AgentStartupError, match="not authorized"):
        parse_contract_probe(_probe_body(), environment=environment)


@pytest.mark.parametrize(
    ("body_overrides", "environment_overrides"),
    [
        ({"runId": "other-run-1234"}, {}),
        ({"callbackUrl": "https://attacker.example/probe-events"}, {}),
        ({"caseId": "other_case"}, {}),
        ({"bootId": "other-boot-1234"}, {}),
        ({"mode": "no_register_join_wait"}, {}),
        ({"callbackSecret": base64.urlsafe_b64encode(b"z" * 32).decode().rstrip("=")}, {}),
        ({}, {"PROVIDER_CONTRACT_PROBE_ACTIVATION_SECRET": _secret()}),
    ],
)
def test_activation_proof_binds_exact_config_and_out_of_band_values(
    body_overrides: dict[str, object], environment_overrides: dict[str, str]
) -> None:
    body = _probe_body()
    cast(dict[str, object], body["providerContractProbe"]).update(body_overrides)
    with pytest.raises(AgentStartupError, match="not authorized"):
        parse_contract_probe(
            body,
            environment=_activation_environment(**environment_overrides),
        )


def test_body_only_activation_cannot_authorize_an_ssrf_callback() -> None:
    body = _probe_body(
        callbackUrl="https://169.254.169.254/latest/meta-data",
        callbackSecret=_activation_secret(),
    )
    with pytest.raises(AgentStartupError, match="not authorized") as captured:
        parse_contract_probe(body, environment={})
    rendered = "".join(
        traceback.format_exception(
            type(captured.value), captured.value, captured.value.__traceback__
        )
    )
    assert _activation_secret() not in rendered


@pytest.mark.parametrize(
    ("overrides", "secret_canary"),
    [
        ({"version": 2}, None),
        ({"unexpected": True}, None),
        ({"runId": "short"}, None),
        ({"caseId": "x"}, None),
        ({"bootId": "short"}, None),
        ({"mode": "ordinary_call"}, None),
        ({"callbackUrl": "http://collector.example/probe-events"}, None),
        ({"callbackSecret": "secret-canary-too-short"}, "secret-canary-too-short"),
        ({"callbackSecret": "!" * 43}, "!" * 43),
    ],
)
def test_invalid_probe_configuration_fails_closed_without_echoing_secrets(
    overrides: dict[str, object], secret_canary: str | None
) -> None:
    with pytest.raises(
        AgentStartupError, match="provider contract probe configuration is invalid"
    ) as captured:
        _parse(_probe_body(**overrides))

    message = str(captured.value)
    if secret_canary is not None:
        assert secret_canary not in message
        rendered_traceback = "".join(
            traceback.format_exception(
                type(captured.value), captured.value, captured.value.__traceback__
            )
        )
        assert secret_canary not in rendered_traceback
        assert captured.value.__cause__ is None


def test_valid_probe_configuration_is_parsed_and_decodes_exact_secret() -> None:
    config = _parse(_probe_body())

    assert isinstance(config, ContractProbeConfig)
    assert config.mode == "register_pause_before_join"
    assert config.secret_bytes() == b"x" * 32


@pytest.mark.parametrize("event", ["registered", "agent_joined", "agent_left"])
async def test_callback_signs_canonical_body_and_sanitizes_daily_claims(event: str) -> None:
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(204)

    config = cast(ContractProbeConfig, _parse(_probe_body()))
    token = _jwt(
        {
            "exp": 1_900_000_000,
            "eject_at_token_exp": True,
            "is_owner": False,
            "room_name": "synthetic-room",
            "ignored_secret": "must-not-be-forwarded",
        }
    )
    async with ProbeCallback(
        config,
        "session-12345678",
        token,
        transport=httpx.MockTransport(respond),
    ) as callback:
        await callback.send(event)

    assert len(requests) == 1
    request = requests[0]
    body = request.content
    payload = json.loads(body)
    assert payload["event"] == event
    assert payload["dailyClaims"] == {
        "expiresAtEpochSeconds": 1_900_000_000,
        "ejectAtTokenExpiry": True,
        "isOwner": False,
        "roomScoped": True,
    }
    timestamp = request.headers["x-duplexd-contract-timestamp"]
    nonce = request.headers["x-duplexd-contract-nonce"]
    expected = hmac.new(
        b"x" * 32,
        b".".join((timestamp.encode(), nonce.encode(), body)),
        hashlib.sha256,
    ).hexdigest()
    assert request.headers["x-duplexd-contract-signature"] == f"v1={expected}"
    assert config.callback_secret.encode() not in body
    assert b"ignored_secret" not in body
    assert b"synthetic-room" not in body


async def test_callback_failure_does_not_expose_secret_or_provider_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = _secret()
    provider_canary = "provider-error-body-canary"
    attempts = 0

    async def respond(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503, text=provider_canary)

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("duplexd_agent.contract_probe.asyncio.sleep", no_sleep)
    config = cast(
        ContractProbeConfig,
        _parse(_probe_body(callbackSecret=secret)),
    )
    async with ProbeCallback(
        config,
        "session-12345678",
        None,
        transport=httpx.MockTransport(respond),
    ) as callback:
        with pytest.raises(
            AgentStartupError, match="provider contract callback failed"
        ) as captured:
            await callback.send("registered")

    assert attempts == 3
    assert secret not in str(captured.value)
    assert provider_canary not in str(captured.value)


async def test_pause_before_join_registers_without_creating_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[str] = []

    async def send(_self: ProbeCallback, event: str) -> None:
        sent.append(event)
        raise RuntimeError("registered-and-paused")

    async def reject_transport(_args: RunnerArguments, _params: dict[str, Any]) -> BaseTransport:
        raise AssertionError("pause-before-join must not create a transport")

    monkeypatch.setattr(ProbeCallback, "send", send)
    config = cast(ContractProbeConfig, _parse(_probe_body()))

    with pytest.raises(RuntimeError, match="registered-and-paused"):
        await run_contract_probe(
            _runner_args(_probe_body()),
            config,
            transport_factory=reject_transport,
            transport_params={},
        )

    assert sent == ["registered"]


async def test_no_registration_mode_skips_callback_before_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[str] = []

    async def send(_self: ProbeCallback, event: str) -> None:
        sent.append(event)

    async def stop_at_transport(_args: RunnerArguments, _params: dict[str, Any]) -> BaseTransport:
        raise RuntimeError("transport-boundary")

    monkeypatch.setattr(ProbeCallback, "send", send)
    config = cast(
        ContractProbeConfig,
        _parse(_probe_body(mode="no_register_join_wait")),
    )

    with pytest.raises(RuntimeError, match="transport-boundary"):
        await run_contract_probe(
            _runner_args(_probe_body(mode="no_register_join_wait")),
            config,
            transport_factory=stop_at_transport,
            transport_params={},
        )

    assert sent == []


async def test_probe_requires_provider_session_correlation_before_callback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    send_called = False

    async def send(_self: ProbeCallback, _event: str) -> None:
        nonlocal send_called
        send_called = True

    monkeypatch.setattr(ProbeCallback, "send", send)
    config = cast(ContractProbeConfig, _parse(_probe_body()))

    with pytest.raises(AgentStartupError, match="requires runner session_id"):
        await run_contract_probe(
            _runner_args(_probe_body(), session_id=None),
            config,
            transport_factory=cast(Any, None),
            transport_params={},
        )

    assert send_called is False


async def test_bootstrap_probe_bypasses_customer_and_model_surfaces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[RunnerArguments, ContractProbeConfig]] = []

    async def run_probe(
        runner_args: RunnerArguments,
        config: ContractProbeConfig,
        **_kwargs: object,
    ) -> None:
        calls.append((runner_args, config))

    def reject_platform(_input: object) -> object:
        raise AssertionError("probe must not construct the customer platform client")

    async def reject_transport(_args: RunnerArguments, _params: dict[str, Any]) -> BaseTransport:
        raise AssertionError("patched probe must bypass ordinary transport creation")

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    for key, value in _activation_environment().items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(bot_module, "run_contract_probe", run_probe)
    args = _runner_args(_probe_body())

    await bot_module.bootstrap(
        args,
        platform_client_factory=cast(Any, reject_platform),
        transport_factory=reject_transport,
    )

    assert len(calls) == 1
    assert calls[0][0] is args
    assert calls[0][1].case_id == "cold_start"
