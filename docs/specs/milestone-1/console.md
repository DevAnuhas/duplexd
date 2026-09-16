# Design spec: apps/console

An observation and demo surface. Start a browser call, watch the transcript and delegation timeline live, end the call, inspect completed calls. It configures nothing about agents and never holds a provider key. Vite and React.

Package `@duplexd/console`. Depends on `@duplexd/contracts` for event and record types and for the NDJSON parser. In development Vite proxies `/v1` to the server; in milestone 1 there is no production build target beyond `pnpm build` succeeding.

## Screens

Two screens, one layout.

```html
<!doctype html>
<html><head><style>
body{font:14px system-ui;margin:0;background:#f6f6f6;color:#111}
.top{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #ddd}
.banner{background:#fff4d6;border-bottom:1px solid #e6c97a;padding:6px 16px;font-size:13px}
.wrap{display:grid;grid-template-columns:2fr 1fr;gap:12px;padding:12px 16px}
.card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;background:#e8f0ff}
.badge.warn{background:#ffe3e3}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee}
.u{color:#333}.a{color:#0a58ca}
button{padding:6px 12px}
</style></head><body>
<div class="top"><b>duplexd console</b><span>API key: <code>dev-key…</code> <button>change</button> · <a href="#">Calls</a></span></div>
<div class="banner">Sample handler: mock booking backend at http://localhost:8787/delegations. No real bookings are made.</div>
<div class="wrap">
  <div class="card">
    <div class="row"><span>Session <code>live_9f3…</code></span><span><span class="badge">active</span> <button>End call</button></span></div>
    <p class="u"><b>caller</b> hi, can I get a table for two on Thursday at seven</p>
    <p class="a"><b>model</b> Sure, let me check that for you while we keep chatting. Anything else on the booking?</p>
    <p class="u"><b>caller</b> a window seat if</p>
    <p class="a"><b>model</b> Noted. And I have your Thursday seven o'clock confirmed, table for two, sample code B-1042.</p>
  </div>
  <div class="card">
    <b>Delegations</b>
    <div class="row"><span>item_9tA2… @ 00:04.1</span><span class="badge">done · 2 appends</span></div>
    <div class="row"><span>item_7cQ1… @ 00:11.8</span><span class="badge warn">handler timed out · 1 append</span></div>
    <div class="row"><span>item_3kL9… @ 00:15.2</span><span class="badge">running</span></div>
    <hr>
    <b>Session</b>
    <div class="row"><span>state</span><span>active</span></div>
    <div class="row"><span>appends sent / rejected</span><span>2 / 1 (over budget)</span></div>
    <div class="row"><span>raw provider events</span><span><button>show</button></span></div>
  </div>
</div>
</body></html>
```

### Call

- **Start**: a short instructions field (prefilled with a demo policy that tells the model to delegate booking requests), a voice field, and a Start button. Start requests microphone permission, runs the WebRTC steps in [webrtc-transport.md](webrtc-transport.md), and opens the event stream.
- **Start failed**: if `POST /v1/sessions` returns an error, the Start form stays on screen with a red banner showing the problem `code` and message. No session row, badge, or timeline appears, because no session exists; a creation the provider rejected before allocating an id has no record either, and the Calls screen will not list it. The person can edit the form and try again.
- **Live**: transcript grouped by role, appended from `transcript.*.delta`; delegation list with per-delegation outcome and append count; session state badge; counters for appends sent and rejected with the rejection reason; End call.
- **End**: End call posts close; the state badge moves to `closing` and then to whatever terminal event arrives. The console never shows `closed` on its own initiative.

### Calls

- List of persisted records for the key, newest first, with state, duration from usage, delegation count.
- Detail: the full `CallRecord`, transcript, delegations with outcomes, appends and rejected appends, usage, reason.

## Event stream

`GET /v1/sessions/:id/events` is NDJSON, one `CoreEvent` per line, with whitespace keepalives. The console consumes it with `fetch` and a stream reader so the `Authorization` header is sent, and parses it with the contract package's `parseNdjson` instantiated over the `CoreEvent` schema. Same parser as the server uses for handler streams; nothing stream-shaped is hand-written in the console. On disconnect the console reconnects and replays from `seq` 1, with the "state unknown" banner in between.

## Honest states

Every state the core can report is rendered as itself. A mapping table lives in one module:

| Event or state | Display |
| --- | --- |
| `created`, `started`, `active`, `closing` | neutral badge with the word |
| `closed` | green badge, usage seconds shown |
| `incomplete` | amber badge with the reason string; `instance_lost` reads "server lost this session" |
| `failed` | red badge with the reason string |
| `delegation.finished` outcome `timeout` | amber "handler timed out · N appends", where N is the delegation's `append.sent` count. The appends already listed under the delegation stay. The console makes no claim about what was or was not spoken: a timeout means the broker stopped waiting, and a handler may have been heard before that (ADR 007). |
| outcome `error` | red with the error text |
| outcome `cancelled` | grey |
| `append.rejected` | inline row under the delegation with the reason, and `chars` or `tokens` when present |
| event stream disconnect | banner "lost connection to server; session state unknown" until reconnected and replayed |

No spinner is allowed to imply progress the server has not reported.

## Sample labeling

The banner names the handler URL the server reports for the session (from `GET /v1/sessions/:id`, `handler.url`) and, when it matches the local example handler, says "sample handler" and "no real bookings are made". `AGENTS.md`: sample handlers are visibly labeled.

## API key handling

The key is typed into a dialog and stored in `localStorage` under a single name. It is sent as the `Authorization` header on every request, including the event stream. It is never built into the bundle and never appears in a URL. This is a consumer key; the provider key never reaches the browser.

## Styling

Minimal, readable, system font, no component library required. Whatever the implementer picks must keep the transcript legible while it scrolls and the timeline visible at the same time on a laptop screen. Not a design showcase; `CONTEXT.md` says the console is not a dashboard product.

## Tests

`pnpm --filter @duplexd/console test`: the event reducer (every `CoreEvent` type produces the expected view state; out-of-order `seq` is rejected; replay then live tail yields one timeline), the stream reader over a fixture NDJSON body with keepalives, the state-to-display mapping is exhaustive over the contract enums (a type-level test), the Start form shows the error banner and no session on a stubbed 502, the key is absent from any URL the client builds. Browser behavior (WebRTC, audio) is verified by the recorded session in T12, not by unit tests.

## Acceptance evidence

Report each as passed, failed, blocked, or not run:

- `pnpm --filter @duplexd/console lint`, `typecheck`, `test`, `build` pass.
- A person can start a call, see the live transcript and delegation timeline update, interrupt, and end the call; recorded in T12 with the session id.
- Every failure state the core can report has a display (type-level test) and the timeout (both the silent hang and the commentary-then-hang, showing the preserved append) and incomplete paths were seen on screen at least once in T12 (screenshots).
- A rejected session creation shows the error banner on the Start form and creates no session row (tested with a stubbed 502).
- The console never receives the provider API key (network inspection in T12).
- The sample-handler banner is visible during the recorded demo.
