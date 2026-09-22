import {
  sandboxResourcesReleased,
  type SandboxBrowserAttempt,
} from "@/sandbox/browser-contract"
import { SANDBOX_LIMITS, type SandboxJoin } from "@/sandbox/protocol"
import type { SandboxMedia, SandboxMediaFactory } from "./media"

import type { SandboxPrepareInput } from "@/sandbox/admission"

export type SandboxClientState = {
  phase: "loading" | "idle" | "preparing" | "canceling" | "unknown" | "error"
  attempt: SandboxBrowserAttempt | null
  message: string | null
  statusKnown: boolean
  conflict: { kind: "assistant" | "samples"; revision: number } | null
  canRetryPreparation: boolean
  mediaPhase:
    | "off"
    | "checking"
    | "starting"
    | "joining"
    | "waiting"
    | "ready"
    | "reconnecting"
    | "finishing"
  muted: boolean
  ownsController: boolean
  /** Bounds already enforced by this controller, republished on the *client*
   * clock so the panel can count down to them without trusting the laptop's
   * clock or hardcoding a duration. `0` means "does not apply yet".
   *
   * These are the same skew-corrected, monotonically clamped values the
   * controller acts on — not a second estimate that could disagree with the
   * deadline that actually fires. A countdown that disagreed with the thing it
   * counts down to would be worse than no countdown. */
  deadlines: { reservation: number; startup: number; execution: number }
}

const messages: Record<string, string> = {
  workspace_session_required:
    "Your session expired. Sign in again, then refresh the test status.",
  invalid_origin:
    "This workspace could not authorize the request. Reload this page.",
  invalid_csrf_token:
    "Your session changed. Reload this page before trying again.",
  assistant_changed:
    "The assistant changed in another tab. Reload to test the latest saved version.",
  samples_changed:
    "Samples changed in another tab. Reload to review the latest samples.",
  assistant_not_found:
    "This assistant is no longer available. Return to Assistants.",
  invalid_sandbox_configuration:
    "This configuration needs attention. Reload to check its fields and sample coverage.",
  sandbox_attempt_active:
    "You already have a prepared or unresolved test. Review or cancel it before preparing another.",
  sandbox_user_rate_exceeded:
    "Too many preparations. Wait a minute, then try again.",
  sandbox_account_rate_exceeded:
    "Your workspace has prepared too many tests. Wait a minute, then try again.",
  sandbox_account_capacity_exceeded:
    "Your workspace has unresolved tests. Resolve those before preparing another.",
  sandbox_execution_disabled:
    "Voice calls are unavailable. Preparation does not start an agent or connect audio.",
  attempt_not_owned: "Only the person who prepared this test can cancel it.",
  attempt_not_found:
    "This test is no longer available. Refresh the page to check current tests.",
  attempt_conflict:
    "This preparation conflicts with an earlier request. Refresh its status before continuing.",
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function attemptFrom(value: unknown): SandboxBrowserAttempt | null {
  const item = record(value)
  if (
    item === null ||
    typeof item.attemptId !== "string" ||
    typeof item.callId !== "string" ||
    typeof item.state !== "string" ||
    typeof item.callState !== "string" ||
    typeof item.reservationExpiresAt !== "string" ||
    item.source !== "sandbox" ||
    item.testMode !== "practice" ||
    (item.execution !== "disabled" && item.execution !== "enabled")
  )
    return null
  const optional = (key: string) =>
    typeof item[key] === "string" ? (item[key] as string) : null
  if (
    item.execution === "enabled" &&
    (typeof item.serverTime !== "string" ||
      !Number.isFinite(Date.parse(item.serverTime)))
  )
    return null
  // Explicit projection: credentials in an unexpected response never enter state.
  return {
    attemptId: item.attemptId,
    callId: item.callId,
    state: item.state,
    callState: item.callState,
    assistantId: optional("assistantId"),
    source: "sandbox",
    testMode: "practice",
    configSource: optional("configSource"),
    baseAssistantRevision:
      typeof item.baseAssistantRevision === "number"
        ? item.baseAssistantRevision
        : null,
    preparedAt: optional("preparedAt") ?? "",
    reservationExpiresAt: item.reservationExpiresAt,
    canceledAt: optional("canceledAt"),
    expiredAt: optional("expiredAt"),
    stopRequestedAt: optional("stopRequestedAt"),
    execution: item.execution,
    resourceState: optional("resourceState") ?? "possible",
    startupDeadline: optional("startupDeadline"),
    executionDeadline: optional("executionDeadline"),
    presenceExpiresAt: optional("presenceExpiresAt"),
    serverTime: optional("serverTime") ?? "",
    readyAt: optional("readyAt"),
  }
}

/**
 * Every Sandbox request but one. Long enough for a database round trip on a
 * cold connection, short enough that a hung request does not strand the tab.
 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Start is the exception, and it has to be.
 *
 * The server is allowed to spend its whole `dispatchMs` budget on the provider
 * call — a cold agent really does take that long — and only then commits the
 * settlement transaction and reconciles before it can answer. A client that
 * gave up at `dispatchMs` could therefore never see a slow success: it would
 * abandon a dispatch that had already created a paid session, report a failure
 * the user can do nothing about, and leave the cleanup to the sweeper. That is
 * exactly what happened on the first real call.
 *
 * So the browser waits for the settlement it asked for. The ceiling above this
 * one is `tick()`, which abandons a start still unanswered 35 seconds after the
 * gesture; this stays below it, so the honest "dispatch outcome is unknown"
 * path is still reachable when the server truly never answers.
 */
const START_TIMEOUT_MS = SANDBOX_LIMITS.dispatchMs + 15_000

/** Resource confirmation, not call outcome, releases editor/admission ownership. */
export const sandboxReleased = sandboxResourcesReleased

/** In-memory controller proof never survives refresh, navigation to another assistant,
 * or another tab. An observed attempt can be stopped but cannot be joined. */
export class SandboxController {
  private state: SandboxClientState = {
    phase: "loading",
    attempt: null,
    message: null,
    statusKnown: false,
    conflict: null,
    canRetryPreparation: false,
    mediaPhase: "off",
    muted: false,
    ownsController: false,
    deadlines: { reservation: 0, startup: 0, execution: 0 },
  }
  private listeners = new Set<() => void>()
  private busy = false
  private pending: { input: SandboxPrepareInput; proof: string } | null = null
  private csrf: string | null = null
  private ownership: {
    attemptId: string
    proof: string
    started: boolean
  } | null = null
  private media: SandboxMedia | null = null
  private cancelMedia: (() => void) | null = null
  private generation = 0
  private joined = false
  private stopping: {
    attemptId: string
    generation: number
    promise: Promise<void>
  } | null = null
  private deadlineTimer: ReturnType<typeof setInterval> | null = null
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private presenceBusy = false
  private expires = { reservation: 0, startup: 0, execution: 0, presence: 0 }
  private timingAttempt: string | null = null
  private fixedBounds: Partial<
    Record<"reservation" | "startup" | "execution", number>
  > = {}
  private presenceExpiry = 0
  private reconnectDeadline = 0
  private reconnectCount = 0
  private interrupted = false
  private mediaDeadline = 0
  private serverClock = { server: 0, local: 0 }

  constructor(
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    private readonly now: () => number = () => performance.now()
  ) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<SandboxClientState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  private async request(
    path: string,
    body?: unknown,
    proof?: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    const startedAt = this.now()
    if (body !== undefined && this.csrf === null) {
      const response = await this.fetcher("/api/workspace/sandbox/csrf", {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const data = record(await response.json())
      if (!response.ok || typeof data?.token !== "string") {
        return { ok: false, status: response.status, data, startedAt }
      }
      this.csrf = data.token
    }
    const response = await this.fetcher(`/api/workspace/sandbox/${path}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined
        ? {}
        : {
            headers: {
              "content-type": "application/json",
              "x-duplexd-csrf": this.csrf!,
              ...(proof === undefined
                ? {}
                : { "x-duplexd-controller-proof": proof }),
            },
            body: JSON.stringify(body),
          }),
    })
    return {
      startedAt,
      ok: response.ok,
      status: response.status,
      data: record(await response.json()),
    }
  }
  private message(data: Record<string, unknown> | null) {
    const code = typeof data?.code === "string" ? data.code : ""
    return (
      messages[code] ??
      "Could not confirm the request. Refresh the test status before trying again."
    )
  }
  async refresh() {
    if (this.busy) return
    this.busy = true
    const epoch = this.generation
    try {
      const path =
        this.state.attempt === null || sandboxReleased(this.state.attempt)
          ? "attempts/current"
          : `attempts/${encodeURIComponent(this.state.attempt.attemptId)}`
      const response = await this.request(path)
      if (epoch !== this.generation) return
      if (!response.ok) {
        this.update({
          phase: "error",
          statusKnown: false,
          message: this.message(response.data),
        })
        if (this.media)
          void this.end(
            "Call authorization or status is unavailable. Local audio stopped; checking cleanup."
          )
        return
      }
      const attempt = attemptFrom(response.data?.attempt)
      if (response.data?.attempt !== null && attempt === null)
        throw new Error("Invalid attempt response")
      const unresolved = this.pending !== null && attempt === null
      this.update({
        attempt:
          attempt ??
          (this.pending === null &&
          this.state.attempt !== null &&
          sandboxReleased(this.state.attempt)
            ? this.state.attempt
            : null),
        statusKnown: true,
        phase: unresolved ? "unknown" : "idle",
        message: unresolved
          ? "Preparation was not confirmed. Retry the same request to reconcile it; no voice call was started."
          : null,
        canRetryPreparation: unresolved,
      })
      if (attempt !== null) {
        this.pending = null
        this.busy = false
        this.observe(attempt, response.startedAt)
      }
    } catch {
      if (epoch !== this.generation) return
      this.update({
        phase: "error",
        statusKnown: false,
        message:
          "Test status is unavailable. Your existing test has not been canceled. Refresh status when the connection returns.",
      })
      if (this.media)
        void this.end(
          "Call status is unavailable. Local audio stopped; checking cleanup."
        )
    } finally {
      if (epoch === this.generation) {
        this.busy = false
        this.update({})
      }
    }
  }
  async prepare(input: Omit<SandboxPrepareInput, "clientAttemptId">) {
    if (
      this.busy ||
      (this.state.attempt !== null && !sandboxReleased(this.state.attempt))
    )
      return
    if (this.pending === null) {
      if (typeof globalThis.crypto?.randomUUID !== "function") {
        this.update({
          phase: "error",
          message:
            "This browser cannot securely prepare a test. Open the workspace on HTTPS or localhost in a supported browser.",
        })
        return
      }
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const proof = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
      this.pending = {
        input: {
          ...structuredClone(input),
          clientAttemptId: crypto.randomUUID(),
        },
        proof,
      }
    }
    this.busy = true
    this.update({
      attempt: null,
      phase: "preparing",
      message: null,
      conflict: null,
      canRetryPreparation: false,
    })
    try {
      const response = await this.request(
        "attempts",
        this.pending.input,
        this.pending.proof
      )
      const attempt = attemptFrom(response.data?.attempt)
      if (response.ok && attempt !== null) {
        this.takeOwnership(attempt, this.pending!.proof, response.startedAt)
        this.pending = null
        this.update({
          phase: "idle",
          attempt,
          message: null,
          statusKnown: true,
        })
      } else if (response.status >= 500 || response.ok) {
        this.update({
          phase: "unknown",
          message:
            "Preparation was not confirmed. Retry the same request or refresh status; no voice call was started.",
          canRetryPreparation: true,
        })
      } else {
        this.pending = null
        this.update({
          phase: "error",
          attempt: attempt ?? this.state.attempt,
          message: this.message(response.data),
          conflict:
            (response.data?.code === "assistant_changed" ||
              response.data?.code === "samples_changed") &&
            typeof response.data.currentRevision === "number"
              ? {
                  kind:
                    response.data.code === "assistant_changed"
                      ? "assistant"
                      : "samples",
                  revision: response.data.currentRevision,
                }
              : null,
        })
      }
    } catch {
      this.update({
        phase: "unknown",
        message:
          "The connection was lost before preparation was confirmed. Retry the same request or refresh status; no voice call was started.",
        canRetryPreparation: true,
      })
    } finally {
      this.busy = false
      this.update({})
    }
  }
  async cancel() {
    if (
      this.media !== null ||
      this.ownership?.started ||
      this.state.mediaPhase === "finishing" ||
      (this.state.attempt !== null &&
        !sandboxReleased(this.state.attempt) &&
        this.state.attempt.resourceState !== "not_dispatched")
    )
      return this.end()
    if (this.busy || this.state.attempt === null) return
    this.busy = true
    this.update({ phase: "canceling", message: null })
    try {
      const response = await this.request(
        `attempts/${encodeURIComponent(this.state.attempt.attemptId)}/stop`,
        {}
      )
      const attempt = attemptFrom(response.data?.attempt)
      if (response.ok && attempt !== null) {
        this.pending = null
        this.update({ phase: "idle", attempt, canRetryPreparation: false })
        this.observe(attempt, response.startedAt)
      } else {
        this.update({
          phase: "error",
          attempt: attempt ?? this.state.attempt,
          message: this.message(response.data),
        })
      }
    } catch {
      this.update({
        phase: "error",
        message:
          "Cancellation was not confirmed. Refresh status or retry cancellation. No new test will be prepared while this one is unresolved.",
      })
    } finally {
      this.busy = false
      this.update({})
    }
  }

  private takeOwnership(
    attempt: SandboxBrowserAttempt,
    proof: string,
    startedAt: number
  ) {
    this.ownership = { attemptId: attempt.attemptId, proof, started: false }
    this.update({ ownsController: true, mediaPhase: "off", muted: false })
    this.observe(attempt, startedAt)
  }
  private observe(attempt: SandboxBrowserAttempt, startedAt: number) {
    const server = Date.parse(attempt.serverTime)
    this.serverClock = { server, local: startedAt }
    if (this.timingAttempt !== attempt.attemptId) {
      this.timingAttempt = attempt.attemptId
      this.fixedBounds = {}
      this.presenceExpiry = 0
      this.expires = { reservation: 0, startup: 0, execution: 0, presence: 0 }
    }
    const fixed = (
      key: "reservation" | "startup" | "execution",
      value: string | null,
      cap: number
    ) => {
      const delta = value === null ? NaN : Date.parse(value) - server
      if (!Number.isFinite(delta)) return 0
      // Sending the request precedes the server's observation. Network latency
      // must consume the lease, never become additional capture time.
      const candidate = startedAt + Math.min(cap, Math.max(0, delta))
      const bound = Math.min(this.fixedBounds[key] ?? candidate, candidate)
      this.fixedBounds[key] = bound
      return bound
    }
    this.expires.reservation = fixed(
      "reservation",
      attempt.reservationExpiresAt,
      30_000
    )
    this.expires.startup = fixed("startup", attempt.startupDeadline, 120_000)
    this.expires.execution = fixed(
      "execution",
      attempt.executionDeadline,
      600_000
    )
    this.observePresence(attempt.presenceExpiresAt, server, startedAt)
    this.update({
      deadlines: {
        reservation: this.expires.reservation,
        startup: this.expires.startup,
        execution: this.expires.execution,
      },
    })
    if (sandboxReleased(attempt)) {
      this.releaseMedia()
      this.ownership = null
      this.update({ mediaPhase: "off", ownsController: false })
    } else if (
      this.media &&
      (attempt.execution !== "enabled" ||
        attempt.stopRequestedAt !== null ||
        ["stopping", "start_unknown", "failed", "ended", "incomplete"].includes(
          attempt.state
        ) ||
        ["failed", "ended", "incomplete"].includes(attempt.callState))
    ) {
      void this.end(
        "Local audio stopped. Waiting for confirmed resource cleanup."
      )
    } else if (
      !this.media &&
      (attempt.stopRequestedAt !== null || attempt.state === "stopping")
    ) {
      this.update({ mediaPhase: "finishing" })
    } else this.checkReadiness()
  }
  private observePresence(
    value: string | null,
    server: number,
    startedAt: number
  ) {
    const absolute = value === null ? NaN : Date.parse(value)
    const delta = absolute - server
    if (!Number.isFinite(delta)) {
      this.expires.presence = 0
      return
    }
    const candidate = startedAt + Math.min(60_000, Math.max(0, delta))
    if (absolute > this.presenceExpiry) {
      // Only a strictly newer persisted lease is a renewal. An out-of-order
      // observation cannot undo it, and an unchanged expiry cannot extend it.
      this.presenceExpiry = absolute
      this.expires.presence = candidate
    } else if (absolute === this.presenceExpiry) {
      this.expires.presence = Math.min(this.expires.presence, candidate)
    }
  }
  private validExecution() {
    const attempt = this.state.attempt
    const now = this.now()
    return (
      attempt !== null &&
      attempt.execution === "enabled" &&
      attempt.stopRequestedAt === null &&
      ![
        "stopping",
        "start_unknown",
        "failed",
        "ended",
        "incomplete",
        "canceled",
        "expired",
      ].includes(attempt.state) &&
      now < this.expires.execution &&
      now < this.expires.presence &&
      ((attempt.readyAt !== null &&
        Number.isFinite(Date.parse(attempt.readyAt))) ||
        now < this.expires.startup)
    )
  }
  private checkReadiness() {
    if (!this.media || this.state.mediaPhase === "finishing") return
    if (this.joined && this.validExecution() && !this.interrupted) {
      const ready = this.state.attempt?.readyAt
      this.update({
        mediaPhase:
          ready && Number.isFinite(Date.parse(ready)) ? "ready" : "waiting",
      })
    }
  }
  canStart() {
    return (
      !this.busy &&
      this.state.statusKnown &&
      this.state.mediaPhase === "off" &&
      this.state.attempt?.state === "prepared" &&
      this.state.attempt.execution === "enabled" &&
      this.ownership?.attemptId === this.state.attempt.attemptId &&
      !this.ownership.started &&
      this.now() < this.expires.reservation
    )
  }
  /** Must be called directly by a user gesture. Nothing on mount calls this. */
  async start(factory: SandboxMediaFactory) {
    if (!this.canStart()) return
    const owner = this.ownership!
    const epoch = ++this.generation
    this.busy = true
    this.joined = false
    this.reconnectCount = 0
    this.interrupted = false
    this.reconnectDeadline = 0
    this.mediaDeadline = this.now() + 20_000
    this.update({
      mediaPhase: "checking",
      message: "Allow microphone access and audio playback before starting.",
      muted: false,
    })
    const canceled = new Promise<never>((_resolve, reject) => {
      this.cancelMedia = () => reject(new Error("Media canceled"))
    })
    // Attach immediately: cancellation can happen before the first await.
    void canceled.catch(() => {})
    const step = <T>(promise: Promise<T>) => Promise.race([promise, canceled])
    try {
      const media = factory((event) => {
        if (epoch !== this.generation) return
        if (event.type === "failed") {
          void this.end(
            "Audio became unavailable. Local audio stopped; checking cleanup."
          )
          return
        }
        if (event.type === "interrupted") {
          this.interrupted = true
          if (this.state.mediaPhase !== "reconnecting") {
            if (++this.reconnectCount > 2) {
              void this.end(
                "Connection recovery limit reached. Local audio stopped."
              )
              return
            }
            this.reconnectDeadline = this.now() + 20_000
            this.update({
              mediaPhase: "reconnecting",
              message:
                "Reconnecting to the same call. No new agent will be started.",
            })
          }
        } else if (this.state.mediaPhase === "reconnecting") {
          this.interrupted = false
          this.reconnectDeadline = 0
          this.update({ mediaPhase: "waiting", message: null })
          this.checkReadiness()
        }
      })
      this.media = media
      this.deadlineTimer = setInterval(() => this.tick(), 250)
      await step(media.prepare())
      if (epoch !== this.generation) return
      if (this.now() >= this.expires.reservation) throw new Error("expired")
      owner.started = true // Before the request: uncertain dispatch is never retried.
      this.update({
        mediaPhase: "starting",
        message: "Starting the prepared test…",
      })
      const response = await step(
        this.request(
          `attempts/${encodeURIComponent(owner.attemptId)}/start`,
          {},
          owner.proof,
          START_TIMEOUT_MS
        )
      )
      if (epoch !== this.generation) return
      const attempt = attemptFrom(response.data?.attempt)
      if (!response.ok || !attempt || attempt.attemptId !== owner.attemptId)
        throw new Error("start")
      this.update({ attempt, statusKnown: true })
      this.observe(attempt, response.startedAt)
      if (epoch !== this.generation) return
      if (!this.validExecution()) throw new Error("lease")
      this.update({
        mediaPhase: "joining",
        message: "Connecting audio to this call…",
      })
      const joinResponse = await step(
        this.request(
          `attempts/${encodeURIComponent(owner.attemptId)}/join`,
          {},
          owner.proof
        )
      )
      if (epoch !== this.generation) return
      const join = record(joinResponse.data?.join)
      if (
        !joinResponse.ok ||
        !join ||
        typeof join.sessionId !== "string" ||
        typeof join.dailyRoom !== "string" ||
        typeof join.dailyToken !== "string" ||
        typeof join.expiresAt !== "string" ||
        !this.validExecution()
      )
        throw new Error("join")
      if (
        Date.parse(join.expiresAt) <=
          this.serverClock.server + this.now() - this.serverClock.local ||
        !Number.isFinite(Date.parse(join.expiresAt))
      )
        throw new Error("Expired join")
      const url = new URL(join.dailyRoom)
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".daily.co") ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("room")
      // Token is only handed to the adapter, never state, storage, URL, log or UI.
      await step(media.join(join as SandboxJoin))
      if (epoch !== this.generation) return
      this.joined = true
      this.update({
        mediaPhase: this.interrupted ? "reconnecting" : "waiting",
        message: "Audio connected. Waiting for persisted agent readiness.",
      })
      this.checkReadiness()
      // Renew before waiting out the first interval, not after it.
      //
      // The lease starts running at dispatch, and the browser only gets here
      // once the start request has returned and the media adapter has joined.
      // On a cold agent that is twenty seconds, and the lease deliberately
      // charges network latency against itself, so by the time audio is
      // connected a sixty-second lease can have well under half of it left.
      // Waiting another fifteen seconds before the first renewal is what
      // killed real calls moments after they went ready.
      //
      // Joining is itself proof the tab is here, so there is nothing to wait
      // for. This also carries the attempt back early, which is how readiness
      // first reaches the browser.
      // Awaited, so the lease is renewed before the deadline ticker can judge
      // it and before anything else observes this controller mid-flight.
      await this.presence(true)
      if (epoch !== this.generation) return
      this.presenceTimer = setInterval(() => {
        void this.presence()
      }, 15_000)
    } catch {
      if (epoch === this.generation)
        await this.end(
          owner.started
            ? "The start or audio connection could not be confirmed. Local audio stopped. No new call will be dispatched; checking cleanup."
            : "Audio permission, playback or preparation expired. No agent was started. Prepare again after checking browser permissions."
        )
    } finally {
      if (epoch === this.generation) {
        this.busy = false
        this.update({})
      }
    }
  }
  private tick() {
    if (!this.media) return
    const now = this.now()
    if (this.state.mediaPhase === "checking") {
      if (now >= Math.min(this.mediaDeadline, this.expires.reservation))
        void this.end("Audio readiness timed out. No agent was started.")
    } else if (this.state.mediaPhase === "starting") {
      if (now >= this.mediaDeadline + 15_000)
        void this.end(
          "Dispatch outcome is unknown. Local audio stopped; checking cleanup."
        )
    } else if (
      !this.validExecution() ||
      (this.reconnectDeadline && now >= this.reconnectDeadline)
    ) {
      void this.end(
        "Call lease or connection recovery expired. Local audio stopped; checking cleanup."
      )
    }
  }
  /**
   * `priming` marks the renewal fired the instant audio connects.
   *
   * The scheduled renewals stay fail-closed: a lease that cannot be renewed is
   * a lease that will expire, and the honest move is to stop local audio. The
   * priming one is different — the lease is definitionally still valid at that
   * moment, and the timer will try again in fifteen seconds — so a transient
   * failure there must not end a call that was previously given the whole
   * first interval before anything was asked of it.
   */
  private async presence(priming = false) {
    const owner = this.ownership
    if (
      this.presenceBusy ||
      !this.media ||
      !owner?.started ||
      !this.validExecution()
    )
      return
    this.presenceBusy = true
    const epoch = this.generation
    try {
      const response = await this.request(
        `attempts/${encodeURIComponent(owner.attemptId)}/presence`,
        {},
        owner.proof
      )
      if (epoch !== this.generation) return
      const server = response.data?.serverTime
      const expiry = response.data?.presenceExpiresAt
      if (
        !response.ok ||
        typeof server !== "string" ||
        typeof expiry !== "string"
      )
        throw new Error("presence")
      const remaining = Date.parse(expiry) - Date.parse(server)
      if (!Number.isFinite(remaining) || remaining <= 0)
        throw new Error("lease")
      // The renewal carries the attempt, which is the only thing that observes
      // readiness once audio is connected: nothing else polls while a call is
      // running, and a call whose `readyAt` is never seen here is torn down by
      // `validExecution` at the startup deadline. `observe` renews the lease on
      // the way through, so this is the renewal, not an extra step after it.
      const attempt = attemptFrom(response.data?.attempt)
      if (attempt !== null && attempt.attemptId === owner.attemptId) {
        this.update({ attempt, statusKnown: true })
        this.observe(attempt, response.startedAt)
      } else {
        this.observePresence(expiry, Date.parse(server), response.startedAt)
      }
    } catch {
      if (epoch === this.generation && !priming)
        void this.end(
          "Presence could not be renewed. Local audio stopped; checking cleanup."
        )
    } finally {
      this.presenceBusy = false
    }
  }
  mute() {
    if (
      !this.media ||
      !["ready", "waiting", "reconnecting"].includes(this.state.mediaPhase)
    )
      return
    const muted = !this.state.muted
    try {
      this.media.mute(muted)
      this.update({ muted })
    } catch {
      void this.end("Microphone control failed. Local audio stopped.")
    }
  }
  private releaseMedia() {
    this.generation++
    if (this.cancelMedia) this.busy = false
    this.cancelMedia?.()
    this.cancelMedia = null
    try {
      this.media?.stop()
    } catch {
      /* Server stop must still be sent. */
    }
    this.media = null
    this.joined = false
    if (this.deadlineTimer) clearInterval(this.deadlineTimer)
    if (this.presenceTimer) clearInterval(this.presenceTimer)
    this.deadlineTimer = this.presenceTimer = null
  }
  /** Stop local audio synchronously, even while start/join/permission is pending. */
  end(
    message = "Local audio stopped. Waiting for confirmed resource cleanup."
  ): Promise<void> {
    const attempt = this.state.attempt
    if (
      this.stopping?.attemptId === attempt?.attemptId &&
      this.stopping?.generation === this.generation
    )
      return this.stopping.promise
    this.releaseMedia()
    this.busy = false
    if (!attempt || sandboxReleased(attempt)) return Promise.resolve()
    const generation = this.generation
    const operation = {
      attemptId: attempt.attemptId,
      generation,
      promise: Promise.resolve(),
    }
    const isCurrent = () =>
      this.generation === generation &&
      this.state.attempt?.attemptId === attempt.attemptId
    this.stopping = operation
    this.update({ mediaPhase: "finishing", message })
    const stop = async () => {
      try {
        const response = await this.request(
          `attempts/${encodeURIComponent(attempt.attemptId)}/stop`,
          {}
        )
        if (!isCurrent()) return
        const current = attemptFrom(response.data?.attempt)
        if (response.ok && current?.attemptId === attempt.attemptId) {
          this.update({ attempt: current, statusKnown: true })
          this.observe(current, response.startedAt)
        } else this.update({ statusKnown: false })
      } catch {
        if (isCurrent()) this.update({ statusKnown: false })
      } finally {
        if (this.stopping === operation) this.stopping = null
      }
    }
    operation.promise = stop()
    return operation.promise
  }

  /** Hiding/leaving never resumes capture automatically on return. */
  leave() {
    if (this.media)
      void this.end(
        "Local audio stopped because you left or hid Sandbox. Checking cleanup."
      )
  }
}
