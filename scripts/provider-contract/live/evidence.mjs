import { chmod, rename, writeFile } from "node:fs/promises"

const SAFE_REFERENCE = /^sha256:[a-f0-9]{64}$/u
const FORBIDDEN_KEYS = new Set([
  "authorization",
  "callbackSecret",
  "credential",
  "dailyRoom",
  "dailyToken",
  "privateKey",
  "publicKey",
  "sessionId",
])

function inspect(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`))
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`${path}.${key} is forbidden in durable evidence`)
    }
    if (key.endsWith("Ref") && !SAFE_REFERENCE.test(child)) {
      throw new Error(`${path}.${key} is not a safe reference`)
    }
    inspect(child, `${path}.${key}`)
  }
}

export function assertSecretFreeEvidence(value, { rawValues = [] } = {}) {
  inspect(value)
  const serialized = JSON.stringify(value)
  for (const raw of rawValues) {
    if (typeof raw === "string" && raw.length > 0 && serialized.includes(raw)) {
      throw new Error("durable evidence contains a volatile raw value")
    }
  }
  return value
}

export async function writeSecretFreeEvidence(path, value, options) {
  assertSecretFreeEvidence(value, options)
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
