import type { DailyCall } from "@daily-co/daily-js"
import { describe, expect, it, vi } from "vitest"
import { deferred, harness, join } from "./helpers/sandbox-media/harness.ts"

vi.mock("@daily-co/daily-js", () => {
  throw new Error("The injected adapter must not load the Daily SDK")
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

  // The output half of this scenario — that no sink is attached either — is
  // asserted in `sandbox-remote-audio.test.ts`, where a sink is observable.
  it("rejects late join success after stop", async () => {
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
  })

  /**
   * Remote output is no longer this file's business. Playing a remote track
   * needs a media element, and this suite runs on Node's globals with no
   * `document` — a playable remote participant here would crash `attach()` and
   * be reported as a failure rather than exercising anything. Everything about
   * sinks lives in `sandbox-remote-audio.test.ts`, which installs a DOM.
   */
  it("releases tracks, listeners, context and client exactly once, then goes quiet", async () => {
    const h = harness()
    const trackRemove = vi.spyOn(h.track, "removeEventListener")
    const contextRemove = vi.spyOn(h.context, "removeEventListener")
    await h.media.prepare()
    await h.media.join(join)
    h.track.dispatchEvent(new Event("mute"))
    h.track.dispatchEvent(new Event("ended"))
    h.context.state = "suspended"
    h.context.dispatchEvent(new Event("statechange"))
    h.emit("error")
    h.emit("left-meeting")
    // One report per failure signal, in order: mute, ended, statechange, error,
    // left-meeting. Asserting the types rather than a count keeps the number
    // derived from the events above instead of tuned to whatever went green.
    expect(h.report.mock.calls.map(([event]) => event.type)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ])
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
  })
})
