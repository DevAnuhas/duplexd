import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { safeReference } from "../lib/contract.mjs"

export const MAX_CALLBACK_BYTES = 4_096
export const MAX_CLOCK_SKEW_SECONDS = 30
export const EVENTS = Object.freeze([
  "registered",
  "agent_joined",
  "agent_left",
])

export function createRunSecret() {
  return randomBytes(32).toString("base64url")
}

export function signActivation({ secret, config }) {
  const message = [
    config.version,
    config.runId,
    config.caseId,
    config.bootId,
    config.mode,
    config.callbackUrl,
    config.callbackSecret,
  ].join("\n")
  return createHmac("sha256", secretBytes(secret)).update(message).digest("hex")
}

function secretBytes(secret) {
  if (typeof secret !== "string") {
    throw new TypeError("HMAC secret is required.")
  }
  const value = Buffer.from(secret, "base64url")
  if (value.length !== 32) {
    throw new TypeError("HMAC secret must decode to exactly 32 bytes.")
  }
  return value
}

export function signCallback({ secret, timestamp, nonce, body }) {
  return createHmac("sha256", secretBytes(secret))
    .update(`${timestamp}.${nonce}.`)
    .update(body)
    .digest("hex")
}

export function verifyCallback({
  secret,
  timestamp,
  nonce,
  signature,
  body,
  nowSeconds = Math.floor(Date.now() / 1_000),
}) {
  if (!/^\d+$/u.test(timestamp ?? "")) {
    return { ok: false, reason: "invalid_timestamp" }
  }
  const observed = Number(timestamp)
  if (Math.abs(nowSeconds - observed) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "expired_timestamp" }
  }
  if (!/^[a-f0-9]{32}$/u.test(nonce ?? "")) {
    return { ok: false, reason: "invalid_nonce" }
  }
  const presented = signature?.startsWith("v1=") ? signature.slice(3) : ""
  if (!/^[a-f0-9]{64}$/u.test(presented)) {
    return { ok: false, reason: "invalid_signature" }
  }
  const expected = signCallback({ secret, timestamp, nonce, body })
  const matches = timingSafeEqual(
    Buffer.from(presented, "hex"),
    Buffer.from(expected, "hex")
  )
  return matches ? { ok: true } : { ok: false, reason: "invalid_signature" }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseCallbackEvent(body, { runId, caseIds }) {
  let value
  try {
    value = JSON.parse(body.toString("utf8"))
  } catch {
    throw new Error("callback body is not JSON")
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("callback version is invalid")
  }
  if (value.runId !== runId || !caseIds.has(value.caseId)) {
    throw new Error("callback run or case is not allowlisted")
  }
  if (
    typeof value.bootId !== "string" ||
    value.bootId.length < 8 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length < 8 ||
    !EVENTS.includes(value.event) ||
    !Number.isSafeInteger(value.observedAt)
  ) {
    throw new Error("callback event shape is invalid")
  }
  if (
    !isRecord(value.dailyClaims) ||
    !Number.isSafeInteger(value.dailyClaims.expiresAtEpochSeconds) ||
    typeof value.dailyClaims.ejectAtTokenExpiry !== "boolean" ||
    typeof value.dailyClaims.isOwner !== "boolean" ||
    typeof value.dailyClaims.roomScoped !== "boolean"
  ) {
    throw new Error("callback Daily claims are invalid")
  }
  return value
}

export function sanitizeCallbackEvent(event) {
  const sanitized = {
    runId: event.runId,
    caseId: event.caseId,
    bootId: safeReference(event.bootId),
    sessionRef: safeReference(event.sessionId),
    event: event.event,
    observedAt: new Date(event.observedAt * 1_000).toISOString(),
  }
  if (isRecord(event.dailyClaims)) {
    sanitized.dailyClaims = {
      expiresAtEpochSeconds: event.dailyClaims.expiresAtEpochSeconds,
      ejectAtTokenExpiry: event.dailyClaims.ejectAtTokenExpiry,
      isOwner: event.dailyClaims.isOwner,
      roomScoped: event.dailyClaims.roomScoped,
    }
  }
  return sanitized
}
