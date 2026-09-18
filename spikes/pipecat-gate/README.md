# Spike: Pipecat GPT-Live client delegation gate

Issue [#21](https://github.com/DevAnuhas/duplexd/issues/21). One question: does a Pipecat agent running `gpt-live-1` in client delegation keep the conversation going while a backend tool call takes several seconds over a real HTTP webhook, and relay the result when it arrives?

This is the gate for the decision recorded in the Traycer artifact `pipecat-landscape`: build the product on Pipecat as the runtime, or continue the duplexd engine. Nothing here is product code. It is not in the pnpm workspace and not in CI.

## Shape

- `assistant.json` is the record a workspace would store: voice, instructions, backend instructions, a `serverUrl`, and `tools` in the OpenAI function format.
- `bot.py` turns every tool into a Pipecat `FunctionSchema` with one shared handler that POSTs `{tool, arguments, call_id}` to `serverUrl`. No tool is hard-coded. The voice model holds no tools; a backend text model picks the tool and calls the webhook.
- `webhook.py` is the stand-in customer backend. It sleeps `WEBHOOK_DELAY_SECS` (default 5) then answers. `restart_server` with `server_name: "broken"` returns HTTP 500 so the honest-failure path can be tried by voice.
- `evidence.py` writes one JSON line per event to `evidence/<session>.jsonl` with monotonic timestamps: bot speech start and stop, tool start and end, delegation created, transcripts, interruptions. `uv run evidence.py` prints, per tool call, whether a bot speech start fell between tool start and tool end.

## Run

Python 3.12 and `uv`. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.

```bash
cd spikes/pipecat-gate
uv sync
uv run webhook.py            # terminal 1, listens on 127.0.0.1:8787
uv run bot.py -t webrtc      # terminal 2, serves http://localhost:7860
```

Open `http://localhost:7860`, connect, and say things like:

1. "Hi, can you look up my latest invoice? My email is kevin at boring host dot ai." Then keep talking while it works.
2. "Restart my server web-1."
3. "Restart the server called broken." Expect a spoken failure, not a fabricated success.
4. While the assistant is mid-sentence, interrupt it with a new request.

Then:

```bash
uv run evidence.py
```

## Acceptance evidence

Report each as passed, failed, blocked, or not run. Paste the `evidence.py` output into the PR.

| Item | How it is read |
| --- | --- |
| Model delegates without tool definitions in its own session | `delegation_created` appears; `LLMContext` for the live model has no tools in `bot.py` |
| Assistant speech during a 5 s webhook | `spoke_during: true` for `lookup_invoice` and `restart_server` |
| Result relayed after the webhook returns | `backend_result` then a `transcript_assistant` mentioning the invoice or restart, after `tool_end` |
| Honest failure | for the `broken` call, `tool_end` has `ok: false` and the following `transcript_assistant` reports a failure |
| Interruption mid-sentence works | heard by ear; `interruption` count or a `bot_speaking_stop` followed by a new `transcript_user` |
| Pins recorded | `pipecat-ai` 1.11.0, Python 3.12 (`uv.lock`) |

## What this does not test

Pipecat Cloud, telephony, a second provider, or any hosting concern. Whether the delegation event reaches a server-side attach connection is moot here because the whole pipeline runs in one process.
