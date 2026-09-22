// Must be the first import: it installs jsdom's globals — `document`,
// `HTMLAudioElement`, `HTMLMediaElement`, `Event`, `EventTarget` — before any
// other module here is evaluated. See the file's own header for why the
// ordering is load-bearing.
import "./helpers/assistant-form/dom-environment.ts"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  deferred,
  harness,
  join,
  participant,
  Stream,
  Track,
  type Harness,
} from "./helpers/sandbox-media/harness.ts"

/**
 * Chromium will not decode a remote WebRTC audio track that is consumed only by
 * a `MediaStreamAudioSourceNode`. Packets arrive, `inbound-rtp` counts them, and
 * `totalSamplesReceived` stays at zero until an `HTMLMediaElement` is attached
 * to the stream — measured on a real loopback: remote RMS 0.000 through the
 * WebAudio path, 0.357 once an `<audio>` element consumed the same track. Two
 * real calls were answered in silence while `bot_speech_started` fired and
 * transcripts persisted.
 *
 * So these tests ask the only question that separated the broken build from the
 * working one: **is there a media element in the document, playing this exact
 * remote track?** They deliberately never assert that an audio node was
 * connected to a destination — that assertion was green throughout the outage.
 *
 * Sinks are discovered with `document.querySelectorAll("audio")`, the way a
 * browser finds them, rather than through an injected seam: a seam would only
 * prove the adapter talked to the fake it was handed.
 *
 * What a jsdom suite cannot prove: that audio is audible. jsdom's `play()` and
 * `pause()` are no-ops, so "the element was played" is a spied call, not a
 * decoded sample. Only a real browser closes that gap.
 */

vi.mock("@daily-co/daily-js", () => {
  throw new Error("The injected adapter must not load the Daily SDK")
})

// jsdom implements neither: `play()` returns `undefined` instead of the promise
// the adapter must be able to `.catch`, and `pause()` never moves `paused`, so a
// teardown assertion has to watch the call rather than the property.
const spyPlay = () =>
  vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve())
const spyPause = () =>
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {})

let play: ReturnType<typeof spyPlay>
let pause: ReturnType<typeof spyPause>

beforeEach(() => {
  vi.stubGlobal("MediaStream", Stream)
  play = spyPlay()
  pause = spyPause()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

/** Every audio sink in the document, found the way a browser would find one. */
function sinks() {
  return [...document.querySelectorAll("audio")]
}

/** The tracks a sink is actually carrying, or a failure naming what it holds. */
function carried(element: HTMLAudioElement) {
  const source = element.srcObject as unknown as Stream | null | undefined
  if (!source || typeof source.getTracks !== "function")
    throw new Error(
      `The sink carries no MediaStream (srcObject is ${String(source)})`
    )
  return source.getTracks()
}

/** A prepared, joined adapter facing the given participants. */
async function connected(participants: (h: Harness) => Record<string, unknown>) {
  const h = harness()
  h.call.participants.mockReturnValue(participants(h))
  await h.media.prepare()
  await h.media.join(join)
  return h
}

/**
 * Replaces `play()` with one whose promise the test settles by hand, so a sink
 * can be torn down while its playback attempt is still in flight.
 */
function pendingPlays() {
  const attempts: {
    sink: HTMLMediaElement
    settle: ReturnType<typeof deferred<void>>
  }[] = []
  play.mockImplementation(function (this: HTMLMediaElement) {
    const settle = deferred<void>()
    attempts.push({ sink: this, settle })
    return settle.promise
  })
  return attempts
}

/** What a browser rejects a pending `play()` with when the sink is torn down. */
const aborted = () =>
  new DOMException("The play() request was interrupted", "AbortError")

/** A macrotask drains every microtask queued behind a settled promise. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("remote audio reaches a media element the browser will decode", () => {
  it("plays the remote track — not the local microphone — from an element in the document", async () => {
    const remote = new Track()
    const h = await connected((h) => ({
      local: participant("local", h.track, { local: true }),
      remote: participant("remote", remote),
    }))

    expect(sinks()).toHaveLength(1)
    const sink = sinks()[0]!
    expect(document.body.contains(sink)).toBe(true)
    expect(sink.autoplay).toBe(true)

    const tracks = carried(sink)
    expect(tracks).toHaveLength(1)
    // Identity, never deep equality: two `Track`s are structurally identical, so
    // `toEqual` here would pass on the wrong track.
    expect(tracks[0]).toBe(remote)
    expect(tracks[0]).not.toBe(h.track)

    expect(play).toHaveBeenCalledTimes(1)
    expect(play.mock.instances[0]).toBe(sink)
  })

  it("keeps one sink per participant across repeated syncs of the same track", async () => {
    const remote = new Track()
    const h = await connected(() => ({ remote: participant("remote", remote) }))
    expect(sinks()).toHaveLength(1)
    const sink = sinks()[0]!

    h.emit("participant-updated")
    h.emit("participant-updated")

    expect(sinks()).toHaveLength(1)
    expect(sinks()[0]).toBe(sink)
    expect(play).toHaveBeenCalledTimes(1)
    expect(carried(sink)[0]).toBe(remote)
  })

  it("replaces a sink when the track is replaced, tearing the old one down", async () => {
    const remote = new Track()
    const replacement = new Track()
    const h = await connected(() => ({ remote: participant("remote", remote) }))
    expect(sinks()).toHaveLength(1)
    const stale = sinks()[0]!

    h.call.participants.mockReturnValue({
      remote: participant("remote", replacement),
    })
    h.emit("participant-updated")

    expect(sinks()).toHaveLength(1)
    const fresh = sinks()[0]!
    expect(fresh).not.toBe(stale)
    expect(carried(fresh)[0]).toBe(replacement)
    expect(play).toHaveBeenCalledTimes(2)
    expect(play.mock.instances[1]).toBe(fresh)

    expect(document.body.contains(stale)).toBe(false)
    expect(pause.mock.instances).toContain(stale)
    expect(stale.srcObject).toBeNull()
  })

  it("tears the sink down when its participant leaves", async () => {
    const remote = new Track()
    const h = await connected(() => ({ remote: participant("remote", remote) }))
    // The precondition is the discriminating half: a build that never creates a
    // sink also satisfies "no sinks remain".
    expect(sinks()).toHaveLength(1)
    const sink = sinks()[0]!

    h.call.participants.mockReturnValue({})
    h.emit("participant-left")

    expect(sinks()).toHaveLength(0)
    expect(document.body.contains(sink)).toBe(false)
    expect(pause.mock.instances).toContain(sink)
    expect(sink.srcObject).toBeNull()
    // Releasing a sink pauses the element; it must never stop a track owned by
    // the far end.
    expect(remote.stop).not.toHaveBeenCalled()
  })

  it("tears every sink down on stop", async () => {
    const first = new Track()
    const second = new Track()
    const h = await connected(() => ({
      first: participant("first", first),
      second: participant("second", second),
    }))
    expect(sinks()).toHaveLength(2)
    const live = sinks()

    h.media.stop()

    expect(sinks()).toHaveLength(0)
    for (const sink of live) {
      expect(document.body.contains(sink)).toBe(false)
      expect(pause.mock.instances).toContain(sink)
      expect(sink.srcObject).toBeNull()
    }
    // Stopping the test releases our own microphone, never the far end's tracks.
    expect(h.track.stop).toHaveBeenCalledOnce()
    expect(first.stop).not.toHaveBeenCalled()
    expect(second.stop).not.toHaveBeenCalled()
  })

  /**
   * These two are a pair and only discriminate together. The rejection is the
   * same `AbortError` in both, so what separates them is solely whether the sink
   * was released first — not the error. A guard that swallowed everything would
   * pass the first and fail the second; one that reported everything, the
   * reverse. They also share `flush()`, so the silent case cannot pass merely by
   * asserting too early: the same wait is long enough for the loud one.
   *
   * Note that `stop()` is deliberately *not* one of the teardown paths here.
   * `failed()` already short-circuits on `stopped`, so a stop-based case stays
   * silent even with the release guard deleted — it proves nothing.
   */
  it("reports a failure when a live sink's playback is refused, so silence never reads as success", async () => {
    const attempts = pendingPlays()
    const remote = new Track()
    const h = await connected(() => ({ remote: participant("remote", remote) }))
    expect(attempts).toHaveLength(1)
    // Still in the document: this sink was never released.
    expect(document.body.contains(attempts[0]!.sink)).toBe(true)

    attempts[0]!.settle.reject(aborted())
    await flush()

    expect(h.report).toHaveBeenCalledWith({ type: "failed" })
  })

  it.each([
    ["its participant leaves", () => ({})],
    [
      "its track is replaced",
      () => ({ remote: participant("remote", new Track()) }),
    ],
  ])(
    "stays silent when a released sink's pending playback aborts because %s",
    async (_, next) => {
      const attempts = pendingPlays()
      const remote = new Track()
      const h = await connected(() => ({
        remote: participant("remote", remote),
      }))
      expect(attempts).toHaveLength(1)
      const stale = attempts[0]!.sink

      h.call.participants.mockReturnValue(next())
      h.emit("participant-updated")
      // The release really happened; the abort below is its consequence.
      expect(document.body.contains(stale)).toBe(false)

      attempts[0]!.settle.reject(aborted())
      await flush()

      expect(h.report).not.toHaveBeenCalled()
      // A sink is paused, never stopped: the track belongs to the far end.
      expect(remote.stop).not.toHaveBeenCalled()
    }
  )

  it("attaches no sink when the join resolves after stop", async () => {
    const remote = new Track()
    const h = harness()
    h.call.participants.mockReturnValue({
      remote: participant("remote", remote),
    })
    await h.media.prepare()
    const joining = deferred<void>()
    h.call.join.mockReturnValueOnce(joining.promise)
    const outcome = expect(h.media.join(join)).rejects.toThrow("Call canceled")
    h.media.stop()
    joining.resolve()
    await outcome

    expect(sinks()).toHaveLength(0)
    expect(play).not.toHaveBeenCalled()
  })

  it("gives each remote participant its own sink and the local participant none", async () => {
    const first = new Track()
    const second = new Track()
    const h = await connected((h) => ({
      local: participant("local", h.track, { local: true }),
      first: participant("first", first),
      second: participant("second", second),
    }))

    expect(sinks()).toHaveLength(2)
    const sources = sinks().map((sink) => carried(sink)[0])
    expect(sources).toContain(first)
    expect(sources).toContain(second)
    expect(sources).not.toContain(h.track)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it("routes no remote track through Web Audio", async () => {
    const remote = new Track()
    const h = await connected(() => ({ remote: participant("remote", remote) }))

    // Paired deliberately: "no source node" alone is satisfied by an adapter
    // that does nothing at all, which is the build that shipped silence.
    expect(sinks()).toHaveLength(1)
    expect(h.context.createMediaStreamSource).not.toHaveBeenCalled()
  })

  /**
   * CONTROL — the only test here that is green both before and after the fix,
   * by construction. It proves the rig can see a sink and intercept `play()`,
   * so a green suite above cannot be an artifact of a blind harness: if
   * `querySelectorAll` or the prototype spy stopped working, every assertion in
   * this file would report "no sinks" and this one would fail alongside them.
   */
  it("CONTROL: the rig observes a media element it did not create", async () => {
    const probe = document.createElement("audio")
    probe.autoplay = true
    probe.srcObject = new Stream([new Track()]) as unknown as MediaStream
    document.body.append(probe)

    expect(sinks()).toHaveLength(1)
    expect(sinks()[0]).toBe(probe)
    expect(carried(probe)).toHaveLength(1)

    await probe.play()
    expect(play).toHaveBeenCalledTimes(1)
    expect(play.mock.instances[0]).toBe(probe)

    probe.remove()
    expect(sinks()).toHaveLength(0)
  })
})

/**
 * The failure mode that cost two calls was silence with every other signal
 * reporting success. Attaching a media element fixes the cause; this watchdog
 * notices if it ever happens again for a different reason.
 *
 * `currentTime` is the signal because a live MediaStream advances it
 * continuously while decoding — agent silence still produces samples — so a
 * frozen value means nothing is being produced at all. It is deliberately
 * advisory: it reports, it withdraws, and it never ends a call. A false
 * positive that hung up on someone mid-sentence would be worse than the
 * confusion it replaces.
 */
describe("silent output is reported, and never ends the call", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A joined adapter with one remote sink whose playback the test drives. */
  async function live() {
    const remote = new Track()
    const h = await connected(() => ({
      remote: participant("remote", remote),
    }))
    const sink = sinks()[0]!
    let played = 0
    Object.defineProperty(sink, "currentTime", {
      configurable: true,
      get: () => played,
    })
    return {
      h,
      /** Decode `seconds` of audio, then let `ticks` watchdog seconds pass. */
      async run(seconds: number, ticks: number) {
        for (let i = 0; i < ticks; i++) {
          played += seconds
          await vi.advanceTimersByTimeAsync(1_000)
        }
      },
      types: () => h.report.mock.calls.map(([event]) => event.type),
    }
  }

  it("stays quiet while a sink has never advanced, because that is startup", async () => {
    const call = await live()
    // Ten seconds of a sink that has never produced a sample. The readiness UI
    // owns this window; a stall warning here would fire on every cold start.
    await call.run(0, 10)
    expect(call.types()).not.toContain("silent")
  })

  it("stays quiet for a stall shorter than three seconds", async () => {
    const call = await live()
    await call.run(1, 2) // advancing: armed
    await call.run(0, 2) // two frozen seconds - renegotiation looks like this
    expect(call.types()).not.toContain("silent")
  })

  it("warns once output has been frozen for three consecutive seconds", async () => {
    const call = await live()
    await call.run(1, 2)
    await call.run(0, 3)
    expect(call.types()).toContain("silent")
    // Advisory only: the call is still running and the adapter still owns it.
    expect(call.types()).not.toContain("failed")
    expect(call.h.call.destroy).not.toHaveBeenCalled()
    expect(call.h.track.stop).not.toHaveBeenCalled()
    expect(sinks()).toHaveLength(1)
  })

  it("says it only once while the stall continues", async () => {
    const call = await live()
    await call.run(1, 2)
    await call.run(0, 6)
    expect(call.types().filter((type) => type === "silent")).toHaveLength(1)
  })

  it("withdraws the warning when output resumes", async () => {
    const call = await live()
    await call.run(1, 2)
    await call.run(0, 3)
    expect(call.types()).toContain("silent")
    await call.run(1, 1)
    expect(call.types()).toContain("audible")
    expect(call.types().at(-1)).toBe("audible")
  })

  /**
   * Asserts the timer is gone, not that the reports stop.
   *
   * The obvious version of this test — stop the call, let six seconds pass,
   * expect no new reports — cannot fail. `observeOutput` already returns early
   * on `this.stopped`, so it is silent whether or not the interval was
   * cleared; verified by mutation, where deleting `stopWatching()` from
   * `stop()` left that version green. What deleting it actually causes is a
   * timer running for the life of the page, and that is what this checks.
   */
  it("clears its watchdog timer when the call ends, rather than leaking it", async () => {
    const call = await live()
    await call.run(1, 2)
    expect(
      vi.getTimerCount(),
      "expected a running watchdog before the call ends"
    ).toBeGreaterThan(0)

    call.h.media.stop()

    expect(vi.getTimerCount()).toBe(0)
  })
})
