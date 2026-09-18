"""Mock customer webhook standing in for a Boring Host backend.

One endpoint, ``POST /tools``, receives ``{"tool": name, "arguments": {...}, "call_id": ...}``
and answers after ``WEBHOOK_DELAY_SECS`` (default 5). The delay is the whole point:
the gate measures whether the voice model keeps talking during it.

A ``server_name`` of ``"broken"`` makes ``restart_server`` return HTTP 500 so the
honest-failure path can be exercised by voice.

Run: ``uv run webhook.py`` (listens on 8787).
"""

import asyncio
import os
import time

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

DELAY_SECS = float(os.environ.get("WEBHOOK_DELAY_SECS", "5"))


class ToolCall(BaseModel):
    tool: str
    arguments: dict
    call_id: str | None = None


@app.post("/tools")
async def tools(call: ToolCall) -> dict:
    started = time.monotonic()
    await asyncio.sleep(DELAY_SECS)

    if call.tool == "lookup_invoice":
        email = str(call.arguments.get("email", "")).lower()
        result = {
            "email": email,
            "invoice_id": "INV-2026-0912",
            "amount_usd": 48.0,
            "status": "unpaid",
            "due": "2026-09-30",
        }
    elif call.tool == "restart_server":
        name = str(call.arguments.get("server_name", ""))
        if name.strip().lower() == "broken":
            raise HTTPException(status_code=500, detail="restart failed: host unreachable")
        result = {"server_name": name, "status": "restarting", "eta_seconds": 40}
    else:
        raise HTTPException(status_code=404, detail=f"unknown tool {call.tool!r}")

    return {"ok": True, "result": result, "webhook_ms": round((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8787, log_level="info")
