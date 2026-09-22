import type { DailyCall, DailyFactoryOptions } from "@daily-co/daily-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DailySandboxMedia } from "@/sandbox/client/daily-media"
import type { SandboxJoin } from "@/sandbox/protocol"

vi.mock("@daily-co/daily-js", () => {
  throw new Error("The injected adapter must not load the Daily SDK")
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
class Track extends EventTarget {
  enabled = true
  readyState = "live"
  stop = vi.fn(() => {
    this.readyState = "ended"
  })
}
class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
}
const join: SandboxJoin = {
  sessionId: "synthetic-session",
  dailyRoom: "https://synthetic.daily.co/test",
  dailyToken: "synthetic-token",
  expiresAt: "2026-09-22T12:10:00Z",
}
function harness() {
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
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Daily adapter with injected browser and SDK boundaries", () => {
  it("does nothing before the gesture and starts capture/output synchronously before creating the client", async () => {
    const h = harness()
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.makeContext).not.toHaveBeenCalled()
    expect(h.createCall).not.toHaveBeenCalled()
    const prepared = h.media.prepare()
    expect(h.context.resume).toHaveBeenCalledOnce()
    expect(h.capture).toHaveBeenCalledOnce()
    expect(h.createCall).not.toHaveBeenCalled()
    await prepared
    expect(h.createCall).toHaveBeenCalledWith(
      expect.objectContaining({
        audioSource: h.track,
        videoSource: false,
        startVideoOff: true,
      })
    )
    expect(h.call.join).not.toHaveBeenCalled()
    h.media.stop()
  })

  it("stops tracks granted after permission cancellation without creating a client", async () => {
    const h = harness()
    const permission = deferred<MediaStream>()
    h.capture.mockReturnValueOnce(permission.promise)
    const outcome = expect(h.media.prepare()).rejects.toThrow(
      "prepare a new test"
    )
    h.media.stop()
    expect(h.context.close).toHaveBeenCalledOnce()
    permission.resolve(h.stream as unknown as MediaStream)
    await outcome
    expect(h.track.stop).toHaveBeenCalledOnce()
    expect(h.createCall).not.toHaveBeenCalled()
    expect(h.report).not.toHaveBeenCalled()
  })

  it("destroys a client whose SDK creation resolves after stop", async () => {
    const h = harness()
    const sdk = deferred<DailyCall>()
    h.createCall.mockReturnValueOnce(sdk.promise)
    const outcome = expect(h.media.prepare()).rejects.toThrow(
      "prepare a new test"
    )
    await vi.waitFor(() => expect(h.createCall).toHaveBeenCalledOnce())
    h.media.stop()
    expect(h.track.stop).toHaveBeenCalledOnce()
    sdk.resolve(h.call as unknown as DailyCall)
    await outcome
    expect(h.call.destroy).toHaveBeenCalledOnce()
    expect(h.call.on).not.toHaveBeenCalled()
  })

  it("rejects output denial and cleans up even when permission resolves later", async () => {
    const h = harness()
    const permission = deferred<MediaStream>()
    h.capture.mockReturnValueOnce(permission.promise)
    h.context.resume.mockRejectedValueOnce(new Error("synthetic output denial"))
    await expect(h.media.prepare()).rejects.toThrow("audio playback")
    expect(h.context.close).toHaveBeenCalledOnce()
    permission.resolve(h.stream as unknown as MediaStream)
    await vi.waitFor(() => expect(h.track.stop).toHaveBeenCalledOnce())
    expect(h.createCall).not.toHaveBeenCalled()
  })

  it.each(["permission", "sdk", "suspended", "ended"])(
    "releases local resources when %s prevents preparation",
    async (failure) => {
      const h = harness()
      if (failure === "permission")
        h.capture.mockRejectedValueOnce(new Error("denied"))
      if (failure === "sdk")
        h.createCall.mockRejectedValueOnce(new Error("load failed"))
      if (failure === "suspended") h.context.state = "suspended"
      if (failure === "ended") h.track.readyState = "ended"
      await expect(h.media.prepare()).rejects.toThrow("prepare a new test")
      expect(h.context.close).toHaveBeenCalledOnce()
      expect(h.track.stop).toHaveBeenCalledTimes(
        failure === "permission" ? 0 : 1
      )
      expect(h.call.join).not.toHaveBeenCalled()
    }
  )

  it("rejects duplicate and concurrent joins and never redials on reconnect events", async () => {
    const h = harness()
    await h.media.prepare()
    const joining = deferred<void>()
    h.call.join.mockReturnValueOnce(joining.promise)
    const first = h.media.join(join)
    await expect(h.media.join(join)).rejects.toThrow("Cannot join")
    joining.resolve()
    await first
    await expect(h.media.join(join)).rejects.toThrow("Cannot join")
    for (const [type, event] of [
      ["signaling", "interrupted"],
      ["sfu", "interrupted"],
      ["signaling", "connected"],
      ["sfu", "connected"],
    ]) {
      h.emit("network-connection", {
        action: "network-connection",
        type,
        event,
      })
    }
    expect(h.report.mock.calls.map(([event]) => event.type)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "connected",
    ])
    expect(h.call.join).toHaveBeenCalledOnce()
    expect(h.call.join).toHaveBeenCalledWith(
      expect.objectContaining({
        url: join.dailyRoom,
        token: join.dailyToken,
        audioSource: h.track,
        videoSource: false,
      })
    )
    h.media.stop()
  })

  it("disables the microphone before signaling and retains mute through join", async () => {
    const h = harness()
    await h.media.prepare()
    h.call.setLocalAudio.mockImplementation((enabled) => {
      expect(h.track.enabled).toBe(enabled)
    })
    h.media.mute(true)
    expect(h.track.enabled).toBe(false)
    await h.media.join(join)
    expect(h.call.setLocalAudio).toHaveBeenLastCalledWith(false)
    h.media.mute(false)
    expect(h.track.enabled).toBe(true)
    h.media.stop()
  })

  it("rejects late join success after stop without reconnecting output", async () => {
    const h = harness()
    await h.media.prepare()
    const joining = deferred<void>()
    h.call.join.mockReturnValueOnce(joining.promise)
    const outcome = expect(h.media.join(join)).rejects.toThrow("Call canceled")
    h.media.stop()
    joining.resolve()
    await outcome
    expect(h.call.destroy).toHaveBeenCalledOnce()
    expect(h.call.setLocalAudio).not.toHaveBeenCalled()
    expect(h.context.createMediaStreamSource).not.toHaveBeenCalled()
  })

  it("owns remote nodes once per track and releases all tracks, listeners, context and client once", async () => {
    vi.stubGlobal("MediaStream", Stream)
    const h = harness()
    const remote = new Track()
    const replacement = new Track()
    const participant = (track: Track, local = false) => ({
      local,
      session_id: local ? "local" : "remote",
      tracks: { audio: { state: "playable", persistentTrack: track } },
    })
    h.call.participants.mockReturnValue({
      local: participant(h.track, true),
      remote: participant(remote),
    })
    const trackRemove = vi.spyOn(h.track, "removeEventListener")
    const contextRemove = vi.spyOn(h.context, "removeEventListener")
    await h.media.prepare()
    await h.media.join(join)
    h.emit("participant-updated")
    expect(h.context.createMediaStreamSource).toHaveBeenCalledOnce()
    const first = h.context.createMediaStreamSource.mock.results[0]!.value
    expect(first.connect).toHaveBeenCalledWith(h.context.destination)
    h.call.participants.mockReturnValue({ remote: participant(replacement) })
    h.emit("participant-updated")
    expect(first.disconnect).toHaveBeenCalledOnce()
    expect(h.context.createMediaStreamSource).toHaveBeenCalledTimes(2)
    const second = h.context.createMediaStreamSource.mock.results[1]!.value
    h.call.participants.mockReturnValue({})
    h.emit("participant-left")
    expect(second.disconnect).toHaveBeenCalledOnce()
    h.track.dispatchEvent(new Event("mute"))
    h.track.dispatchEvent(new Event("ended"))
    h.context.state = "suspended"
    h.context.dispatchEvent(new Event("statechange"))
    h.emit("error")
    h.emit("left-meeting")
    expect(h.report).toHaveBeenCalledTimes(5)
    h.media.stop()
    h.media.stop()
    expect(h.track.stop).toHaveBeenCalledOnce()
    expect(h.context.close).toHaveBeenCalledOnce()
    expect(h.call.destroy).toHaveBeenCalledOnce()
    expect(trackRemove.mock.calls.map(([name]) => name)).toEqual([
      "ended",
      "mute",
    ])
    expect(contextRemove).toHaveBeenCalledWith(
      "statechange",
      expect.any(Function)
    )
    expect(h.call.off).toHaveBeenCalledTimes(h.call.on.mock.calls.length)
    expect([...h.listeners.values()].every((set) => set.size === 0)).toBe(true)
    h.track.dispatchEvent(new Event("ended"))
    h.context.dispatchEvent(new Event("statechange"))
    h.emit("error")
    expect(h.report).toHaveBeenCalledTimes(5)
    expect(remote.stop).not.toHaveBeenCalled()
  })
})
