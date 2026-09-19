from __future__ import annotations

import pytest

from duplexd_agent.instructions import compose_instructions


def test_compose_instructions_pins_complete_order_and_output() -> None:
    assert compose_instructions(
        "Be direct and helpful.",
        "Use a neutral accent.",
        "Acknowledge work before waiting.",
    ) == (
        "Be direct and helpful.\n\n"
        "Use a neutral accent.\n\n"
        "Acknowledge work before waiting."
    )


@pytest.mark.parametrize(
    ("accent_style", "waiting_behavior", "expected"),
    [
        ("", "", "Base instructions."),
        ("  ", "Wait clearly.", "Base instructions.\n\nWait clearly."),
        ("Speak warmly.", "\n", "Base instructions.\n\nSpeak warmly."),
    ],
)
def test_compose_instructions_omits_empty_optional_layers_without_stray_separators(
    accent_style: str, waiting_behavior: str, expected: str
) -> None:
    assert (
        compose_instructions("  Base instructions.  ", accent_style, waiting_behavior)
        == expected
    )
