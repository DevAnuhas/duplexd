import type {
  SandboxAttemptDto,
  SandboxPrepareInput,
} from "@/sandbox/admission"

export type SandboxClientState = {
  phase: "loading" | "idle" | "preparing" | "canceling" | "unknown" | "error"
  attempt: SandboxAttemptDto | null
  message: string | null
  statusKnown: boolean
  conflict: { kind: "assistant" | "samples"; revision: number } | null
  canRetryPreparation: boolean
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

function attemptFrom(value: unknown): SandboxAttemptDto | null {
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
    item.execution !== "disabled"
  )
    return null
  // The server owns this allowlisted DTO. No response payload is logged or persisted.
  return item as SandboxAttemptDto
}

/** No start/join path exists in this preparation-only client. */
export class SandboxController {
  private state: SandboxClientState = {
    phase: "loading",
    attempt: null,
    message: null,
    statusKnown: false,
    conflict: null,
    canRetryPreparation: false,
  }
  private listeners = new Set<() => void>()
  private busy = false
  private pending: { input: SandboxPrepareInput; proof: string } | null = null
  private csrf: string | null = null

  constructor(
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init)
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
  private async request(path: string, body?: unknown, proof?: string) {
    if (body !== undefined && this.csrf === null) {
      const response = await this.fetcher("/api/workspace/sandbox/csrf", {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(15_000),
      })
      const data = record(await response.json())
      if (!response.ok || typeof data?.token !== "string") {
        return { ok: false, status: response.status, data }
      }
      this.csrf = data.token
    }
    const response = await this.fetcher(`/api/workspace/sandbox/${path}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(15_000),
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
    try {
      const path =
        this.state.attempt === null ||
        ["canceled", "expired"].includes(this.state.attempt.state)
          ? "attempts/current"
          : `attempts/${encodeURIComponent(this.state.attempt.attemptId)}`
      const response = await this.request(path)
      if (!response.ok) {
        this.update({
          phase: "error",
          statusKnown: false,
          message: this.message(response.data),
        })
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
          ["canceled", "expired"].includes(this.state.attempt.state)
            ? this.state.attempt
            : null),
        statusKnown: true,
        phase: unresolved ? "unknown" : "idle",
        message: unresolved
          ? "Preparation was not confirmed. Retry the same request to reconcile it; no voice call was started."
          : null,
        canRetryPreparation: unresolved,
      })
      if (attempt !== null) this.pending = null
    } catch {
      this.update({
        phase: "error",
        statusKnown: false,
        message:
          "Test status is unavailable. Your existing test has not been canceled. Refresh status when the connection returns.",
      })
    } finally {
      this.busy = false
    }
  }
  async prepare(input: Omit<SandboxPrepareInput, "clientAttemptId">) {
    if (
      this.busy ||
      (this.state.attempt !== null &&
        !["canceled", "expired"].includes(this.state.attempt.state))
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
    }
  }
  async cancel() {
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
    }
  }
}
