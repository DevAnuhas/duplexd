import type { DailyCall, DailyFactoryOptions } from "@daily-co/daily-js"
import { vi } from "vitest"
import { DailySandboxMedia } from "@/sandbox/client/daily-media"
import type { SandboxJoin } from "@/sandbox/protocol"

/**
 * The synthetic browser and SDK boundary shared by the media adapter's suites.
 *
 * **This module must not import a DOM.** `sandbox-daily-media.test.ts` runs on
 * Node's globals and its tracks extend Node's `EventTarget`; a file that wants a
 * document imports `helpers/assistant-form/dom-environment.ts` as its own first
 * import, which swaps `Event`/`EventTarget` for jsdom's before this module is
 * evaluated. Each test file therefore gets one self-consistent set of globals —
 * pulling jsdom in from here would give the Node-globals file a `Track` whose
 * events its own `new Event(...)` can no longer dispatch.
 */

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

let minted = 0

/**
 * `id` exists so a mismatched track names itself in a failure message, and so
 * two tracks are never interchangeable to a deep-equality assertion that was
 * meant to prove identity. Assertions about which track reached a sink must
 * still use `toBe`: every field here is otherwise identical between instances.
 */
export class Track extends EventTarget {
  readonly id = `track-${++minted}`
  enabled = true
  readyState = "live"
  stop = vi.fn(() => {
    this.readyState = "ended"
  })
}

/** Stands in for `MediaStream`, which jsdom does not implement. */
export class Stream {
  constructor(readonly tracks: Track[] = []) {}
  addTrack(track: Track) {
    if (!this.tracks.includes(track)) this.tracks.push(track)
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
}

export const join: SandboxJoin = {
  sessionId: "synthetic-session",
  dailyRoom: "https://synthetic.daily.co/test",
  dailyToken: "synthetic-token",
  expiresAt: "2026-09-22T12:10:00Z",
}

/** One entry of a `participants()` map, shaped like Daily's. */
export function participant(
  sessionId: string,
  track: Track | null,
  options: { local?: boolean; state?: string } = {}
) {
  return {
    local: options.local ?? false,
    session_id: sessionId,
    tracks: {
      audio: { state: options.state ?? "playable", persistentTrack: track },
    },
  }
}

export function harness() {
  const track = new Track()
  const stream = new Stream([track])
  const context = Object.assign(new EventTarget(), {
    state: "running",
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {
      context.state = "closed"
    }),
    createMediaStreamSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  })
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  const call = {
    on: vi.fn((type: string, listener: (event?: unknown) => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    }),
    off: vi.fn((type: string, listener: (event?: unknown) => void) => {
      listeners.get(type)?.delete(listener)
    }),
    join: vi.fn<(options: unknown) => Promise<void>>(async () => {}),
    destroy: vi.fn(async () => {}),
    setLocalAudio: vi.fn<(enabled: boolean) => void>(() => {}),
    participants: vi.fn((): Record<string, unknown> => ({})),
  }
  // Deliberately partial browser/SDK implementations, confined to the injection seam.
  const capture = vi.fn(async () => stream as unknown as MediaStream)
  const createCall = vi.fn<
    (options: DailyFactoryOptions) => Promise<DailyCall>
  >(async () => call as unknown as DailyCall)
  const makeContext = vi.fn(() => context as unknown as AudioContext)
  const report = vi.fn()
  const media = new DailySandboxMedia(report, {
    capture,
    context: makeContext,
    createCall,
  })
  return {
    media,
    track,
    stream,
    context,
    call,
    listeners,
    capture,
    createCall,
    makeContext,
    report,
    emit(type: string, event?: unknown) {
      listeners.get(type)?.forEach((fn) => fn(event))
    },
  }
}

export type Harness = ReturnType<typeof harness>
