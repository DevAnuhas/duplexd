import type { SandboxBrowserMediaVerifier } from "./pipecat-transport"

/**
 * The one job of this module is to answer "when does the browser's join stop
 * being valid?" — and nothing else.
 *
 * An earlier design wanted this seam to *prove* that the token Pipecat returns
 * is a non-owner, room-scoped audio credential. It cannot: the start contract
 * does not expose the claims that were actually granted, so any check here
 * would be reading back the properties we asked for and calling that evidence.
 * ADR 015 settles it — the bound on a Sandbox call is operational (the Daily
 * room's `exp` with `eject_at_room_exp`, the platform's own execution
 * deadline, the agent watchdog and the sweeper), not a claim inspected here.
 *
 * So this produces an expiry and stays out of the way.
 */

/**
 * The `exp` claim of a JWT, in epoch seconds, or `null`.
 *
 * Signature is not checked and must not be: the token is not addressed to this
 * server, and a valid signature would say nothing about the room it is scoped
 * to. The claim is read as a hint about lifetime, and the value it produces is
 * then clamped by the caller's deadline — so a forged or malformed `exp`
 * cannot extend a call, only shorten it.
 */
function tokenExpirySeconds(token: string): number | null {
  const payload = token.split(".")[1]

  if (payload === undefined) {
    return null
  }

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    )
    const exp =
      decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as { exp?: unknown }).exp
        : undefined

    return typeof exp === "number" && Number.isSafeInteger(exp) && exp > 0
      ? exp
      : null
  } catch {
    return null
  }
}

/**
 * The live verifier: the Daily token's own expiry, never later than the
 * execution deadline the platform already committed to durably.
 *
 * Three cases, all deliberate:
 *
 *  - The token decodes and expires before the deadline — use the token. It is
 *    the earlier of the two bounds and the browser will be ejected then.
 *  - The token does not decode, or expires at or after the deadline — use the
 *    deadline. The platform's own bound is the binding one either way, and an
 *    opaque token is not a reason to refuse a call we can still bound.
 *  - The token decodes and has already expired — refuse. There is no join to
 *    hand the browser; returning the deadline here would produce a credential
 *    that is dead on arrival and a call that fails after the agent has already
 *    started costing money.
 *
 * `now` is injectable for tests only. Nothing else passes it.
 */
export function createPracticeBrowserMediaVerifier(
  now: () => Date = () => new Date()
): SandboxBrowserMediaVerifier {
  return async ({ dailyToken, maximumExpiresAt }) => {
    const maximum = Date.parse(maximumExpiresAt)

    if (!Number.isFinite(maximum) || maximum <= now().getTime()) {
      return null
    }

    const claim = tokenExpirySeconds(dailyToken)

    if (claim === null) {
      return { expiresAt: new Date(maximum).toISOString() }
    }

    const expiry = claim * 1_000

    if (expiry <= now().getTime()) {
      return null
    }

    return { expiresAt: new Date(Math.min(expiry, maximum)).toISOString() }
  }
}
