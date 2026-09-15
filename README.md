# duplexd

A voice transport and delegation broker for full-duplex speech models.

The speech model listens and talks. Your backend thinks. duplexd sits between them: it owns the live audio session, and every time the model needs a fact, a tool, or a decision, duplexd hands the transcript to your backend and streams the answer back into the conversation while the caller keeps talking.

First supported provider: OpenAI `gpt-live-1` in client-delegation mode.

## Status

Documentation only. No code exists yet. Start with [AGENTS.md](AGENTS.md), then [CONTEXT.md](CONTEXT.md) and [docs/MILESTONE.md](docs/MILESTONE.md).

## What it will look like

```
browser / phone ──audio──▶ speech provider
                              │ "I need help"
                              ▼
                           duplexd ──transcript + context──▶ your backend
                              ▲                                   │
                              └──── spoken or silent results ─────┘
```

Your backend receives a transcript and returns results. It never hands duplexd its tools, credentials, or data. See [docs/PROTOCOL.md](docs/PROTOCOL.md).

## License

MIT. See [LICENSE](LICENSE).
