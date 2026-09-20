import { secretsMatch } from "@/lib/crypto"
import { hashCredential } from "@/lib/credentials"

export type SweepAuthFailure =
  "sweep_not_configured" | "missing_header" | "malformed" | "mismatch"

export type SweepAuthDecision =
  { ok: true } | { ok: false; reason: SweepAuthFailure }

/**
 * Authenticates the sweep request without exposing why it failed over HTTP.
 * The reason is returned for unit-level evidence only; the route maps every
 * failure to the same response. Both values are hashed first so the one
 * constant-time comparison always receives equal-length input.
 */
export function authenticateSweep(
  authorization: string | null,
  expectedToken: string | null
): SweepAuthDecision {
  if (expectedToken === null) {
    return { ok: false, reason: "sweep_not_configured" }
  }

  if (authorization === null) {
    return { ok: false, reason: "missing_header" }
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  if (match === null) {
    return { ok: false, reason: "malformed" }
  }

  const candidateDigest = hashCredential(match[1]!)
  const expectedDigest = hashCredential(expectedToken)
  return secretsMatch(candidateDigest, expectedDigest)
    ? { ok: true }
    : { ok: false, reason: "mismatch" }
}
