export type LocalAudioState = {
  kind: "idle" | "requesting" | "listening" | "stopped" | "error"
  message: string
  level: number
}

/** Gesture-only, bounded local audio. Never records or sends microphone data. */
export class LocalAudioCheck {
  private generation = 0
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private meter: ReturnType<typeof setInterval> | null = null
  constructor(private readonly report: (state: LocalAudioState) => void) {}

  stop() {
    this.generation++
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.meter !== null) clearInterval(this.meter)
    this.timer = null
    this.meter = null
    const context = this.context
    this.context = null
    if (context !== null && context.state !== "closed")
      void context.close().catch(() => {})
  }

  async microphone() {
    this.stop()
    const generation = this.generation
    if (!navigator.mediaDevices?.getUserMedia) {
      this.report({
        kind: "error",
        message:
          "Microphone access is unavailable. Use a supported browser on HTTPS or localhost.",
        level: 0,
      })
      return
    }
    this.report({
      kind: "requesting",
      message:
        "Allow microphone access in your browser. You can cancel this check at any time.",
      level: 0,
    })
    this.timer = setTimeout(() => {
      this.stop()
      this.report({
        kind: "error",
        message:
          "Microphone permission timed out. Check browser permissions and try again.",
        level: 0,
      })
    }, 20_000)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      })
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.stream = stream
      if (!stream.getAudioTracks().some((track) => track.readyState === "live"))
        throw new Error("No live input")
      if (this.timer !== null) clearTimeout(this.timer)
      let peak = 0
      this.timer = setTimeout(() => {
        this.stop()
        this.report({
          kind: "stopped",
          message:
            peak > 0.005
              ? "Input detected. Microphone capture is now off."
              : "Microphone opened, but no input was detected. Check your device or mute switch. Capture is now off.",
          level: 0,
        })
      }, 5_000)
      this.context = new AudioContext()
      await this.context.resume()
      if (generation !== this.generation) return
      const source = this.context.createMediaStreamSource(stream)
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const values = new Uint8Array(analyser.fftSize)
      this.report({
        kind: "listening",
        message: "Speak for 5 seconds. Audio stays on this device.",
        level: 0,
      })
      this.meter = setInterval(() => {
        analyser.getByteTimeDomainData(values)
        const rms = Math.sqrt(
          values.reduce(
            (total, value) => total + ((value - 128) / 128) ** 2,
            0
          ) / values.length
        )
        peak = Math.max(peak, rms)
        this.report({
          kind: "listening",
          message: "Speak for 5 seconds. Audio stays on this device.",
          level: Math.min(100, Math.round(rms * 500)),
        })
      }, 100)
    } catch (error) {
      if (generation !== this.generation) return
      this.stop()
      const denied =
        error instanceof DOMException && error.name === "NotAllowedError"
      this.report({
        kind: "error",
        message: denied
          ? "Microphone permission was denied. Allow it in browser settings, then try again."
          : "Could not check microphone input. Check your device and browser audio settings, then try again.",
        level: 0,
      })
    }
  }

  async sound() {
    this.stop()
    const generation = this.generation
    try {
      const context = new AudioContext()
      this.context = context
      this.timer = setTimeout(() => {
        this.stop()
        this.report({
          kind: "error",
          message:
            "Sound playback did not start. Check browser audio permissions and try again.",
          level: 0,
        })
      }, 5_000)
      await context.resume()
      if (generation !== this.generation) return
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = 440
      gain.gain.setValueAtTime(0, context.currentTime)
      gain.gain.linearRampToValueAtTime(0.05, context.currentTime + 0.02)
      gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.3)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.3)
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.stop()
        this.report({
          kind: "stopped",
          message:
            "Test sound finished. If you did not hear it, check your speaker volume and browser output settings.",
          level: 0,
        })
      }, 400)
    } catch {
      if (generation !== this.generation) return
      this.stop()
      this.report({
        kind: "error",
        message:
          "Sound playback is blocked or unavailable. Check browser audio permissions and try again.",
        level: 0,
      })
    }
  }
}
