"""Synthetic local config and customer-webhook stub for P04/P05 integration."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HOST = "127.0.0.1"
PORT = 8787
CALL_ID = "stub-call"
AGENT_TOKEN = "stub-agent-token"
ASSISTANT_ID = "stub-assistant"
SERVER_SECRET = "stub-webhook-secret"


def sample_config() -> dict[str, Any]:
    """Visibly synthetic configuration using the documented camelCase contract."""

    return {
        "assistantId": ASSISTANT_ID,
        "voice": "marin",
        "instructions": "You are the duplexd local sample assistant.",
        "accentStyle": "Speak clearly in a neutral style.",
        "waitingBehavior": "Briefly acknowledge delegated work, then wait.",
        "backendModel": "gpt-5.6-luna",
        "backendInstructions": "Use the configured sample tools and report their result honestly.",
        "serverUrl": f"http://{HOST}:{PORT}/webhook",
        "serverSecret": SERVER_SECRET,
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "sample_lookup",
                    "description": "Return a synthetic value for a supplied key.",
                    "parameters": {
                        "type": "object",
                        "properties": {"key": {"type": "string"}},
                        "required": ["key"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        "webhookTimeoutSecs": 2.0,
        "functionCallTimeoutSecs": 5.0,
        "delegationTimeoutSecs": 10.0,
    }


class StubHandler(BaseHTTPRequestHandler):
    server_version = "duplexd-config-stub"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != f"/v1/agent/calls/{CALL_ID}/config":
            self._json(404, {"error": "not_found"})
            return
        if self.headers.get("Authorization") != f"Bearer {AGENT_TOKEN}":
            self._json(401, {"error": "unauthorized"})
            return
        self._json(200, sample_config())

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        content = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/webhook":
            self._webhook(content)
            return
        if self.path == f"/v1/agent/calls/{CALL_ID}/events":
            self._json(200, {"accepted": True})
            return
        if self.path == f"/v1/agent/calls/{CALL_ID}/complete":
            self._json(200, {"completed": True})
            return
        self._json(404, {"error": "not_found"})

    def _webhook(self, content: bytes) -> None:
        signature = self.headers.get("duplexd-signature", "")
        try:
            fields = dict(part.split("=", 1) for part in signature.split(","))
            timestamp = int(fields["t"])
            supplied = fields["v1"]
        except (KeyError, ValueError):
            self._json(401, {"error": "invalid_signature"})
            return
        expected = hmac.new(
            SERVER_SECRET.encode(),
            str(timestamp).encode("ascii") + b"." + content,
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(supplied, expected) or abs(time.time() - timestamp) > 300:
            self._json(401, {"error": "invalid_signature"})
            return
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid_json"})
            return
        self._json(
            200,
            {
                "result": {
                    "sample": True,
                    "tool": payload.get("tool"),
                    "arguments": payload.get("arguments"),
                }
            },
        )

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def main() -> None:
    print(f"Synthetic duplexd config/webhook stub: http://{HOST}:{PORT}")
    print(f"callId={CALL_ID}; agentToken={AGENT_TOKEN}; local webhooks require flag=1")
    ThreadingHTTPServer((HOST, PORT), StubHandler).serve_forever()


if __name__ == "__main__":
    main()
