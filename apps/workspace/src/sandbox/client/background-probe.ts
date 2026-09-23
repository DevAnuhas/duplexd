/** Temporary, opt-in timing trace for the #82 Chrome preview experiment. */
const KEY = "duplexd-practice-background-probe-v1"
const SEQUENCE_KEY = "duplexd-practice-background-probe-sequence-v1"
const MAX_EVENTS = 256

type ProbeEvent = {
  at: string
  monotonicMs: number
  visibility: DocumentVisibilityState
  event: string
  details: Record<string, string | number | boolean | null>
}

export function practiceProbeEnabled() {
  return (
    typeof window !== "undefined" &&
    window.location.hostname.startsWith(
      "duplexd-git-feat-82-practice-background-continuity-"
    ) &&
    new URLSearchParams(window.location.search).has("practiceProbe")
  )
}

export function nextPracticeProbeSequence() {
  if (!practiceProbeEnabled()) return null
  try {
    const prior = Number(sessionStorage.getItem(SEQUENCE_KEY) ?? "0")
    const next = Number.isSafeInteger(prior) && prior >= 0 ? prior + 1 : 1
    sessionStorage.setItem(SEQUENCE_KEY, String(next))
    return next
  } catch {
    return null
  }
}

export function recordPracticeProbe(
  event: string,
  details: ProbeEvent["details"] = {}
) {
  if (!practiceProbeEnabled()) return
  try {
    const existing = JSON.parse(
      sessionStorage.getItem(KEY) ?? "[]"
    ) as ProbeEvent[]
    const entries = Array.isArray(existing) ? existing : []
    entries.push({
      at: new Date().toISOString(),
      monotonicMs: performance.now(),
      visibility: document.visibilityState,
      event,
      details,
    })
    sessionStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_EVENTS)))
  } catch {
    // Diagnostics must never affect the call or its cleanup.
  }
}

export function practiceProbeExport() {
  try {
    return sessionStorage.getItem(KEY) ?? "[]"
  } catch {
    return "[]"
  }
}
