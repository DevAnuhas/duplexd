"""Cross-language contracts shared by the Python agent and control API.

The API and agent ship from one repository, but their validators live in two
languages. This test deliberately reads the API's runtime data file rather
than copying a second list into a fixture: adding an event in either client
must make the suite fail until the other side accepts it too.
"""

from __future__ import annotations

import json
from pathlib import Path

from duplexd_agent.reporting import EVENT_TYPES


def test_control_api_accepts_exactly_the_agent_event_vocabulary() -> None:
    repository_root = Path(__file__).resolve().parents[2]
    api_types_path = (
        repository_root / "apps" / "workspace" / "src" / "control" / "agent-event-types.json"
    )

    api_types = json.loads(api_types_path.read_text(encoding="utf-8"))

    assert isinstance(api_types, list)
    assert api_types, "the API event vocabulary was blank, so nothing was measured"
    assert len(api_types) == len(set(api_types)), "the API vocabulary contains duplicates"
    assert set(api_types) == EVENT_TYPES


def test_sandbox_end_reasons_and_protocol_match_the_typescript_authority() -> None:
    import re

    from duplexd_agent.config import SANDBOX_END_REASONS, SANDBOX_PROTOCOL

    source = (
        Path(__file__).resolve().parents[2] / "apps/workspace/src/sandbox/protocol.ts"
    ).read_text()
    reasons = re.search(r"export const SANDBOX_END_REASONS = \[(.*?)\] as const", source, re.S)
    assert reasons is not None, "TypeScript Sandbox end-reason authority was not found"
    assert set(re.findall(r'"([a-z_]+)"', reasons[1])) == SANDBOX_END_REASONS
    protocol = re.search(r'export const SANDBOX_PROTOCOL = "([^"]+)"', source)
    assert protocol is not None and protocol[1] == SANDBOX_PROTOCOL


def test_sandbox_ack_control_and_owner_fields_follow_typescript_wire_types() -> None:
    import re
    from typing import get_args

    from pydantic import BaseModel

    from duplexd_agent.config import SandboxAck, SandboxConfig, SandboxControl, SandboxOwner

    source = (
        Path(__file__).resolve().parents[2] / "apps/workspace/src/sandbox/protocol.ts"
    ).read_text()
    models: list[tuple[str, type[BaseModel]]] = [
        ("SandboxEvidenceAck", SandboxAck),
        ("SandboxControl", SandboxControl),
        ("SandboxOwner", SandboxOwner),
        ("SandboxConfig", SandboxConfig),
    ]
    for name, model in models:
        declaration = re.search(rf"export type {name} = \{{(.*?)\}}", source, re.S)
        assert declaration is not None, f"Missing TypeScript wire type: {name}"
        fields = dict(re.findall(r"(\w+):\s*([^;\n]+)", declaration[1]))
        assert set(fields) == set(model.model_fields), f"{name} wire fields drifted"
        for field, type_ in fields.items():
            if type_.strip().isdigit():
                assert get_args(model.model_fields[field].annotation) == (int(type_),)
    states = re.search(r"export type SandboxEvidenceState = ([^\n]+)", source)
    assert states is not None
    assert set(re.findall(r'"([^"]+)"', states[1])) == set(
        get_args(SandboxAck.model_fields["evidenceState"].annotation)
    )
