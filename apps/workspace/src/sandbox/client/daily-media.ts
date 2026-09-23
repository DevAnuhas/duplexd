import type {
  DailyCall,
  DailyFactoryOptions,
  DailyEventObjectNetworkConnectionEvent,
} from "@daily-co/daily-js"
import type { SandboxJoin } from "@/sandbox/protocol"
import type { SandboxMedia, SandboxMediaEvent } from "./media"

type Dependencies = {
  capture: () => Promise<MediaStream>
  context: () => AudioContext
  createCall: (options: DailyFactoryOptions) => Promise<DailyCall>
}
const browser: Dependencies = {
  capture: () =>
    navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
  context: () => new AudioContext(),
  createCall: async (options) => {
    const { default: Daily } = await import("@daily-co/daily-js")
    return Daily.createCallObject(options)
  },
}

/** Uses caller-owned input, a gesture-unlocked AudioContext, and one media
 * element per remote speaker.
 * No SDK import, capture, network or audio work occurs in the constructor.
 */
export class DailySandboxMedia implements SandboxMedia {
  private stopped = false
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private call: DailyCall | null = null
  private outputs = new Map<
    string,
    {
      track: MediaStreamTrack
      sink: HTMLAudioElement
      /** Last observed `currentTime`. A live MediaStream advances it
       * continuously while decoding — agent silence still produces samples —
       * so a frozen value means no audio is being produced at all. */
      played: number
      /** Consecutive observations with no advance. */
      frozen: number
      /** Has this sink ever advanced? Until it has, this is startup, not a
       * stall, and the readiness UI already owns that window. */
      started: boolean
    }
  >()
  private released = new WeakSet<HTMLAudioElement>()
  private watchdog: ReturnType<typeof setInterval> | null = null
  private silent = false
  private interrupted = new Set<string>()
  private joined = false
  private joining = false
  private muted = false
  constructor(
    private readonly report: (event: SandboxMediaEvent) => void,
    private readonly deps: Dependencies = browser
  ) {}

  async prepare() {
    if (this.stopped || this.context) throw new Error("Audio is unavailable")
    try {
      const context = this.deps.context()
      this.context = context
      // Both calls begin in the click stack, before awaiting SDK/network work.
      const output = context.resume()
      void output.catch(() => {})
      const input = this.deps.capture().then((stream) => {
        if (this.stopped) {
          stream.getTracks().forEach((track) => track.stop())
          throw new Error("Audio check canceled")
        }
        this.stream = stream
        return stream
      })
      const [stream] = await Promise.all([input, output])
      const track = stream.getAudioTracks()[0]
      if (
        this.stopped ||
        !track ||
        track.readyState !== "live" ||
        context.state !== "running"
      )
        throw new Error("Audio is unavailable")
      track.addEventListener("ended", this.failed)
      track.addEventListener("mute", this.failed)
      context.addEventListener("statechange", this.contextChanged)
      const call = await this.deps.createCall({
        audioSource: track,
        videoSource: false,
        startVideoOff: true,
        dailyConfig: {
          alwaysIncludeMicInPermissionPrompt: false,
          alwaysIncludeCamInPermissionPrompt: false,
        },
      })
      if (this.stopped) {
        await call.destroy()
        throw new Error("Audio check canceled")
      }
      this.call = call
      call.on("participant-updated", this.syncOutputs)
      call.on("participant-joined", this.syncOutputs)
      call.on("participant-left", this.syncOutputs)
      call.on("network-connection", this.network)
      call.on("error", this.failed)
      call.on("left-meeting", this.failed)
    } catch {
      this.stop()
      throw new Error(
        "Allow microphone access and audio playback, then prepare a new test."
      )
    }
  }
  private failed = () => {
    if (!this.stopped) this.report({ type: "failed" })
  }
  private contextChanged = () => {
    if (this.context?.state !== "running") this.failed()
  }
  private network = (
    event: DailyEventObjectNetworkConnectionEvent | undefined
  ) => {
    if (this.stopped || event?.action !== "network-connection") return
    if (event.event === "interrupted") this.interrupted.add(event.type)
    else if (event.event === "connected") this.interrupted.delete(event.type)
    else return
    this.report({ type: this.interrupted.size ? "interrupted" : "connected" })
  }
  private syncOutputs = () => {
    try {
      this.connectOutputs()
    } catch {
      this.failed()
    }
  }
  private connectOutputs() {
    if (!this.call || this.stopped) return
    const tracks = new Map<string, MediaStreamTrack>()
    for (const participant of Object.values(this.call.participants())) {
      if (participant.local) continue
      const audio = participant.tracks.audio
      if (audio.state === "playable" && audio.persistentTrack)
        tracks.set(participant.session_id, audio.persistentTrack)
    }
    for (const [id, output] of this.outputs) {
      if (tracks.get(id) !== output.track) {
        this.release(output.sink)
        this.outputs.delete(id)
      }
    }
    for (const [id, track] of tracks) {
      if (this.outputs.has(id)) continue
      this.outputs.set(id, {
        track,
        sink: this.attach(track),
        played: 0,
        frozen: 0,
        started: false,
      })
    }
    if (this.outputs.size === 0) this.stopWatching()
    else if (this.watchdog === null)
      this.watchdog = setInterval(this.observeOutput, 1_000)
  }
  /** How many consecutive frozen seconds before saying anything. One stalled
   * tick during renegotiation is normal; three in a row is not. */
  private static readonly STALL_TICKS = 3
  /**
   * Notices the failure mode that cost two calls: audio arriving and nothing
   * coming out, with every other signal reporting success.
   *
   * Deliberately advisory. It reports and it withdraws; it never ends a call.
   * The owner has already lost attempts to things that stopped a call without
   * explaining why, and a false positive here would be one more.
   */
  private observeOutput = () => {
    if (this.stopped) return
    let advancing = false
    let stalled = false
    for (const output of this.outputs.values()) {
      const played = output.sink.currentTime
      if (played > output.played) {
        output.played = played
        output.frozen = 0
        output.started = true
        advancing = true
      } else if (output.started) {
        output.frozen += 1
        if (output.frozen >= DailySandboxMedia.STALL_TICKS) stalled = true
      }
    }
    if (!this.silent && stalled && !advancing) {
      this.silent = true
      this.report({ type: "silent" })
    } else if (this.silent && advancing) {
      this.silent = false
      this.report({ type: "audible" })
    }
  }
  private stopWatching() {
    if (this.watchdog !== null) clearInterval(this.watchdog)
    this.watchdog = null
    this.silent = false
  }
  /** Remote audio needs a media element, not a Web Audio node.
   *
   * Chromium does not run the decoder for a remote WebRTC track that is only
   * consumed by a MediaStreamAudioSourceNode. Measured on a loopback peer
   * connection against this exact graph: 1224 packets and 98 KB arrived,
   * `totalSamplesReceived` stayed at 0, and the analyser read a peak RMS of
   * 0.000 — while the same graph fed by a *local* track read 0.355, so the
   * measurement was sound. Attaching an element to the same stream moved it to
   * 158,400 samples and 0.357. That is the whole of the outage on 2026-09-22:
   * every layer reported success and nobody could hear the agent.
   *
   * So the element is the sink and the remote Web Audio path is gone rather
   * than kept alongside — two sinks on one stream would play the agent twice.
   */
  private attach(track: MediaStreamTrack) {
    const sink = document.createElement("audio")
    sink.autoplay = true
    sink.srcObject = new MediaStream([track])
    // Held by the document so the element cannot be collected mid-call.
    document.body.append(sink)
    // `play()` returns nothing under jsdom, and a promise in a browser.
    void Promise.resolve(sink.play()).catch(() => {
      // Tearing a sink down while its `play()` is still pending rejects that
      // promise with AbortError. That is an ordinary release, not a refusal.
      // A genuine refusal is silence, and silence must not read as success.
      if (!this.released.has(sink)) this.failed()
    })
    return sink
  }
  private release(sink: HTMLAudioElement) {
    this.released.add(sink)
    sink.pause()
    sink.srcObject = null
    sink.remove()
  }
  async join(join: SandboxJoin) {
    if (!this.call || this.stopped || this.joined || this.joining)
      throw new Error("Cannot join")
    this.joining = true
    // No rejoin/redial. Daily's in-room reconnect is bounded by the controller.
    await this.call.join({
      url: join.dailyRoom,
      token: join.dailyToken,
      audioSource: this.stream!.getAudioTracks()[0],
      videoSource: false,
      startVideoOff: true,
    })
    if (this.stopped) throw new Error("Call canceled")
    this.joined = true
    this.call.setLocalAudio(!this.muted)
    this.syncOutputs()
  }
  mute(muted: boolean) {
    this.muted = muted
    // Local track first; do not wait for the SDK/signaling round trip.
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
    this.call?.setLocalAudio(!muted)
  }
  stop() {
    if (this.stopped) return
    this.stopped = true
    this.stream?.getTracks().forEach((track) => {
      track.removeEventListener("ended", this.failed)
      track.removeEventListener("mute", this.failed)
      track.stop()
    })
    this.stream = null
    this.stopWatching()
    this.outputs.forEach(({ sink }) => this.release(sink))
    this.outputs.clear()
    const context = this.context
    this.context = null
    context?.removeEventListener("statechange", this.contextChanged)
    if (context && context.state !== "closed")
      void context.close().catch(() => {})
    const call = this.call
    this.call = null
    if (call) {
      try {
        call.off("participant-updated", this.syncOutputs)
        call.off("participant-joined", this.syncOutputs)
        call.off("participant-left", this.syncOutputs)
        call.off("network-connection", this.network)
        call.off("error", this.failed)
        call.off("left-meeting", this.failed)
        void call.destroy().catch(() => {})
      } catch {
        /* Local tracks/output are already released. */
      }
    }
  }
}
