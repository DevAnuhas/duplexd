import type { SandboxEventPage } from "@/sandbox/protocol"

type Event = SandboxEventPage["events"][number]
export type TimelineState = {
  events: Event[]
  evidence: SandboxEventPage["evidence"] | null
  loading: boolean
  error: string | null
  limited: boolean
  hasMore: boolean
  updatedAt: number | null
}
const MAX_EVENTS = 2000
const MAX_BYTES = 2 * 1024 * 1024
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid evidence")
  return value as Record<string, unknown>
}
function safeEvent(value: unknown): Event {
  const event = object(value)
  if (
    (event.namespace !== "agent" && event.namespace !== "platform") ||
    !Number.isSafeInteger(event.seq) ||
    Number(event.seq) < 0 ||
    typeof event.cursor !== "string" ||
    event.cursor.length > 256 ||
    typeof event.at !== "string" ||
    !Number.isFinite(Date.parse(event.at)) ||
    typeof event.type !== "string" ||
    event.type.length > 100
  )
    throw new Error("Invalid event")
  const payload: Event["payload"] = {}
  const raw = event.payload ? object(event.payload) : {}
  // Re-project at the rendering boundary. Never keep raw tool arguments/results.
  const keys =
    event.type === "transcript_user" || event.type === "transcript_assistant"
      ? ["text"]
      : event.type === "tool_started" || event.type === "tool_finished"
        ? [
            "tool",
            "invocationId",
            "outcome",
            "durationMs",
            "status",
            "practiceScenario",
            "practiceSelectedStatus",
          ]
        : []
  for (const key of keys) {
    const val = raw[key]
    if (typeof val === "string")
      payload[key] = val.slice(0, key === "text" ? 8000 : 160)
    else if (typeof val === "number" && Number.isFinite(val)) payload[key] = val
  }
  return {
    cursor: event.cursor,
    namespace: event.namespace,
    seq: Number(event.seq),
    at: event.at,
    type: event.type,
    payload,
  }
}
export function readEventPage(value: unknown): SandboxEventPage {
  const page = object(value)
  const evidence = object(page.evidence)
  if (
    !Array.isArray(page.events) ||
    page.events.length > 100 ||
    typeof page.hasMore !== "boolean" ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" || page.nextCursor.length > 256)) ||
    !["unknown", "partial", "complete"].includes(String(evidence.state)) ||
    !Number.isSafeInteger(evidence.contiguousSeq) ||
    Number(evidence.contiguousSeq) < 0 ||
    (evidence.finalSeq !== null &&
      (!Number.isSafeInteger(evidence.finalSeq) ||
        Number(evidence.finalSeq) < 0)) ||
    ["producerLoss", "truncated", "integrityConflict", "reconciled"].some(
      (key) => typeof evidence[key] !== "boolean"
    )
  )
    throw new Error("Invalid evidence page")
  return {
    events: page.events.map(safeEvent),
    nextCursor: page.nextCursor as string | null,
    hasMore: page.hasMore,
    evidence: {
      state: evidence.state as SandboxEventPage["evidence"]["state"],
      contiguousSeq: Number(evidence.contiguousSeq),
      finalSeq: evidence.finalSeq as number | null,
      producerLoss: Boolean(evidence.producerLoss),
      truncated: Boolean(evidence.truncated),
      integrityConflict: Boolean(evidence.integrityConflict),
      reconciled: Boolean(evidence.reconciled),
    },
  }
}

// Preserve each producer's sequence even when its timestamps arrive out of order.
// Interleave the two producer streams by their next timestamp, not an inconsistent comparator.
function ordered(events: Event[]) {
  const agent = events
    .filter((event) => event.namespace === "agent")
    .sort((a, b) => a.seq - b.seq)
  const platform = events
    .filter((event) => event.namespace === "platform")
    .sort((a, b) => a.seq - b.seq)
  const result: Event[] = []
  let a = 0,
    p = 0
  while (a < agent.length || p < platform.length) {
    if (
      a < agent.length &&
      (p >= platform.length || agent[a]!.at <= platform[p]!.at)
    )
      result.push(agent[a++]!)
    else result.push(platform[p++]!)
  }
  return result
}

export class SandboxTimelineController {
  private state: TimelineState = {
    events: [],
    evidence: null,
    loading: false,
    error: null,
    limited: false,
    hasMore: false,
    updatedAt: null,
  }
  private listeners = new Set<() => void>()
  private cursor: string | null = null
  private bytes = 0
  private abort: AbortController | null = null
  private disposed = false
  constructor(
    private readonly callId: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)
  ) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<TimelineState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((fn) => fn())
  }
  async refresh() {
    if (this.disposed || this.abort || this.state.limited) return
    const abort = new AbortController()
    this.abort = abort
    this.update({ loading: true })
    try {
      // A long history cannot monopolize the tab. Later polls continue this cursor.
      for (let index = 0; index < 3; index++) {
        const response = await this.fetcher(
          `/api/workspace/sandbox/calls/${encodeURIComponent(this.callId)}/events${this.cursor ? `?after=${encodeURIComponent(this.cursor)}` : ""}`,
          {
            cache: "no-store",
            credentials: "same-origin",
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(10_000),
            ]),
          }
        )
        if (!response.ok)
          throw new Error(
            response.status === 401 || response.status === 403
              ? "auth"
              : "unavailable"
          )
        const raw = await response.text()
        if (new TextEncoder().encode(raw).length > 131072)
          throw new Error("Oversized evidence")
        const page = readEventPage(JSON.parse(raw))
        if (this.disposed || abort.signal.aborted) return
        if (
          page.hasMore &&
          (page.nextCursor === null || page.nextCursor === this.cursor)
        )
          throw new Error("Non-advancing cursor")
        const keys = new Set(
          this.state.events.map((event) => `${event.namespace}:${event.seq}`)
        )
        const additions = page.events.filter((event) => {
          const key = `${event.namespace}:${event.seq}`
          if (keys.has(key)) return false
          keys.add(key)
          return true
        })
        const bytes = new TextEncoder().encode(JSON.stringify(additions)).length
        if (
          this.state.events.length + additions.length > MAX_EVENTS ||
          this.bytes + bytes > MAX_BYTES
        ) {
          this.update({
            limited: true,
            hasMore: true,
            error: null,
            evidence: page.evidence,
          })
          return
        }
        this.bytes += bytes
        this.cursor = page.nextCursor ?? this.cursor
        this.update({
          events: ordered([...this.state.events, ...additions]),
          evidence: page.evidence,
          updatedAt: Date.now(),
          hasMore: page.hasMore,
          error: null,
        })
        if (!page.hasMore) break
      }
    } catch (error) {
      if (!this.disposed && !abort.signal.aborted)
        this.update({
          error:
            error instanceof Error && error.message === "auth"
              ? "Sign in again to load more evidence. Previously loaded events are kept."
              : "Evidence updates are unavailable. Previously loaded events are kept; retry when the connection returns.",
        })
    } finally {
      this.abort = null
      if (!this.disposed) this.update({ loading: false })
    }
  }
  pause() {
    this.abort?.abort()
  }
  dispose() {
    this.disposed = true
    this.pause()
  }
}
