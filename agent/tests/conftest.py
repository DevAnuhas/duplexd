from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest


@pytest.fixture
def runner_body() -> dict[str, str]:
    return {
        "callId": "call_test_123",
        "apiBase": "http://127.0.0.1:8791",
        "agentToken": "agent-token-canary-never-log",
    }


@pytest.fixture
def config_payload() -> dict[str, Any]:
    return {
        "assistantId": "assistant_test_123",
        "voice": "marin",
        "instructions": "Be direct and helpful.",
        "accentStyle": "Use a neutral accent.",
        "waitingBehavior": "Acknowledge work before waiting.",
        "backendModel": "gpt-test-responses",
        "backendInstructions": "Backend-instructions-canary-never-reach-voice.",
        "serverUrl": "https://customer.example/tools",
        "serverSecret": "webhook-secret-canary-never-log",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "lookup_invoice",
                    "description": "Look up an invoice by email.",
                    "parameters": {
                        "type": "object",
                        "properties": {"email": {"type": "string"}},
                        "required": ["email"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "restart_server",
                    "description": "Restart a named server.",
                    "parameters": {
                        "type": "object",
                        "properties": {"server_name": {"type": "string"}},
                        "required": ["server_name"],
                    },
                },
            },
        ],
        "webhookTimeoutSecs": 1.0,
        "functionCallTimeoutSecs": 5.0,
        "delegationTimeoutSecs": 10.0,
    }


@pytest.fixture
def fresh_config(config_payload: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(config_payload)
