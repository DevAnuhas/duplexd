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

/** Uses caller-owned input and a gesture-unlocked Web Audio output graph.
 * No SDK import, capture, network or audio work occurs in the constructor.
 */
export class DailySandboxMedia implements SandboxMedia {
  private stopped = false
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private call: DailyCall | null = null
  private outputs = new Map<
    string,
    { track: MediaStreamTrack; node: MediaStreamAudioSourceNode }
  >()
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
    if (!this.call || !this.context || this.stopped) return
    const tracks = new Map<string, MediaStreamTrack>()
    for (const participant of Object.values(this.call.participants())) {
      if (participant.local) continue
      const audio = participant.tracks.audio
      if (audio.state === "playable" && audio.persistentTrack)
        tracks.set(participant.session_id, audio.persistentTrack)
    }
    for (const [id, output] of this.outputs) {
      if (tracks.get(id) !== output.track) {
        output.node.disconnect()
        this.outputs.delete(id)
      }
    }
    for (const [id, track] of tracks) {
      if (this.outputs.has(id)) continue
      const node = this.context.createMediaStreamSource(
        new MediaStream([track])
      )
      node.connect(this.context.destination)
      this.outputs.set(id, { track, node })
    }
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
    this.outputs.forEach(({ node }) => node.disconnect())
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
