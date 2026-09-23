/** Temporary, opt-in timing trace for the #82 Chrome preview experiment. */
const KEY = "duplexd-practice-background-probe-v1"
const SEQUENCE_KEY = "duplexd-practice-background-probe-sequence-v1"
const OPT_IN_KEY = "duplexd-practice-background-probe-opt-in-v1"
const MAX_EVENTS = 256
const PROBE_HOST =
  "duplexd-git-feat-82-practice-background-796959-anuhas-projects.vercel.app"

type ProbeEvent = {
  at: string
  monotonicMs: number
  visibility: DocumentVisibilityState
  event: string
  details: Record<string, string | number | boolean | null>
}

export function practiceProbeAllowed(hostname: string, search: string) {
  // Vercel truncates long branch aliases and appends a stable hash. This is
  // the exact alias assigned to #82; deployment URLs and production stay off.
  return (
    hostname === PROBE_HOST && new URLSearchParams(search).has("practiceProbe")
  )
}

export function practiceProbeEnabled() {
  if (typeof window === "undefined") return false
  const hostname = window.location.hostname
  const selected = practiceProbeAllowed(hostname, window.location.search)
  if (hostname !== PROBE_HOST) return false
  try {
    if (selected) sessionStorage.setItem(OPT_IN_KEY, "true")
    return sessionStorage.getItem(OPT_IN_KEY) === "true"
  } catch {
    return selected
  }
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
