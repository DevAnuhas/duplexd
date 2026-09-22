import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  LocalAudioCheck,
  type LocalAudioState,
} from "@/sandbox/client/local-audio"

const streams: Array<{ stop: ReturnType<typeof vi.fn> }> = []
function stream() {
  const track = { stop: vi.fn(), readyState: "live" }
  streams.push(track)
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream
}
let contexts: FakeContext[] = []
class FakeContext {
  state = "running"
  currentTime = 0
  destination = {}
  close = vi.fn(async () => {
    this.state = "closed"
  })
  resume = vi.fn(async () => {})
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
  createAnalyser = vi.fn(() => ({
    fftSize: 256,
    getByteTimeDomainData: (bytes: Uint8Array) => {
      bytes.fill(140)
    },
  }))
  createOscillator = vi.fn(() => ({
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }))
  createGain = vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  }))
  constructor() {
    contexts.push(this)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  contexts = []
  streams.length = 0
  vi.stubGlobal("AudioContext", FakeContext)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("local audio lifecycle", () => {
  it("stops every track arriving after cancellation", async () => {
    let resolve!: (stream: MediaStream) => void
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((done) => {
              resolve = done
            })
        ),
      },
    })
    const report = vi.fn<(state: LocalAudioState) => void>()
    const audio = new LocalAudioCheck(report)
    const pending = audio.microphone()
    audio.stop()
    resolve(stream())
    await pending
    expect(streams[0]?.stop).toHaveBeenCalledOnce()
    expect(contexts).toHaveLength(0)
    expect(report.mock.calls.map((call) => call[0].kind)).not.toContain(
      "listening"
    )
  })
  it("bounds capture to five seconds and disconnects its audio context", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream()) },
    })
    const report = vi.fn<(state: LocalAudioState) => void>()
    const audio = new LocalAudioCheck(report)
    await audio.microphone()
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "listening" })
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(streams[0]?.stop).toHaveBeenCalledOnce()
    expect(contexts[0]?.close).toHaveBeenCalledOnce()
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "stopped",
        message: "Input detected. Microphone capture is now off.",
      })
    )
    expect(vi.getTimerCount()).toBe(0)
  })
  it("bounds the permission prompt and releases a stream granted after timeout", async () => {
    let resolve!: (stream: MediaStream) => void
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((done) => {
              resolve = done
            })
        ),
      },
    })
    const report = vi.fn<(state: LocalAudioState) => void>()
    const audio = new LocalAudioCheck(report)
    const pending = audio.microphone()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "error" })
    )
    resolve(stream())
    await pending
    expect(streams[0]?.stop).toHaveBeenCalledOnce()
  })
  it("releases an old capture when another check starts", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream()) },
    })
    const audio = new LocalAudioCheck(vi.fn())
    await audio.microphone()
    await audio.microphone()
    expect(streams[0]?.stop).toHaveBeenCalledOnce()
    expect(contexts[0]?.close).toHaveBeenCalledOnce()
    audio.stop()
    expect(streams[1]?.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("reports mic denial without making network requests or constructing audio", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("denied", "NotAllowedError")
        }),
      },
    })
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const report = vi.fn<(state: LocalAudioState) => void>()
    await new LocalAudioCheck(report).microphone()
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("permission was denied"),
      })
    )
    expect(contexts).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("plays a bounded local tone without microphone access", async () => {
    const mic = vi.fn()
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: mic } })
    const report = vi.fn<(state: LocalAudioState) => void>()
    const audio = new LocalAudioCheck(report)
    await audio.sound()
    await vi.advanceTimersByTimeAsync(400)
    expect(mic).not.toHaveBeenCalled()
    expect(contexts[0]?.close).toHaveBeenCalledOnce()
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "stopped",
        message: expect.stringContaining("If you did not hear it"),
      })
    )
  })
})
