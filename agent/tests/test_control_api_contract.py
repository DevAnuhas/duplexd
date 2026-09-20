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
        repository_root
        / "apps"
        / "workspace"
        / "src"
        / "control"
        / "agent-event-types.json"
    )

    api_types = json.loads(api_types_path.read_text(encoding="utf-8"))

    assert isinstance(api_types, list)
    assert api_types, "the API event vocabulary was blank, so nothing was measured"
    assert len(api_types) == len(set(api_types)), "the API vocabulary contains duplicates"
    assert set(api_types) == EVENT_TYPES
