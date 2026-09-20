import { randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { decryptSecret, encryptSecret, secretsMatch } from "@/lib/crypto"

/**
 * AES-256-GCM helpers. No database — these run everywhere, including a fresh
 * clone with nothing configured, because the key is set by the test.
 *
 * The canary is distinctive on purpose. Several assertions below are "this
 * string appears nowhere", and a plaintext of `"secret"` would produce
 * accidental matches that make such an assertion meaningless.
 */

const PLAINTEXT = "canary-webhook-secret-7Qx4fZ2LmN8pVr3T"
const KEY_HEX = "a".repeat(64)
const OTHER_KEY_HEX = "b".repeat(64)

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
function parts(serialised: string): {
  version: string
  iv: string
  tag: string
  ciphertext: string
} {
  const [version, iv, tag, ciphertext] = serialised.split(".")

  return {
    version: version ?? "",
    iv: iv ?? "",
    tag: tag ?? "",
    ciphertext: ciphertext ?? "",
  }
}

/** Flips one bit in a base64url segment, so it decodes but is no longer valid. */
function corrupt(segment: string): string {
  const bytes = Buffer.from(segment, "base64url")
  bytes[0] = (bytes[0] ?? 0) ^ 0xff

  return bytes.toString("base64url")
}

function rebuild(p: {
  version: string
  iv: string
  tag: string
  ciphertext: string
}): string {
  return [p.version, p.iv, p.tag, p.ciphertext].join(".")
}

describe("encryptSecret and decryptSecret", () => {
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.ASSISTANT_SECRET_KEY
    process.env.ASSISTANT_SECRET_KEY = KEY_HEX
  })

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.ASSISTANT_SECRET_KEY
    } else {
      process.env.ASSISTANT_SECRET_KEY = previousKey
    }
  })

  it("round-trips a secret", () => {
    expect(decryptSecret(encryptSecret(PLAINTEXT))).toBe(PLAINTEXT)
  })

  it("round-trips unicode and long secrets", () => {
    const awkward = `${"🔐".repeat(200)}\n\ttrailing space `

    expect(decryptSecret(encryptSecret(awkward))).toBe(awkward)
  })

  it("never stores the plaintext in the serialised form", () => {
    expect(encryptSecret(PLAINTEXT)).not.toContain(PLAINTEXT)
  })

  /**
   * The IV-uniqueness test. If the IV is pinned to a constant, GCM turns into a
   * deterministic cipher: the same plaintext yields byte-identical output, which
   * leaks equality between two customers' secrets and — under a reused IV with
   * the same key — collapses GCM's security entirely.
   *
   * Every one of the three assertions fails under a fixed IV. Asserting only on
   * the whole string would too, but naming the IV and ciphertext segments says
   * what actually broke when it does.
   */
  it("produces different ciphertext for the same plaintext each time", () => {
    const first = parts(encryptSecret(PLAINTEXT))
    const second = parts(encryptSecret(PLAINTEXT))

    expect(second.iv).not.toBe(first.iv)
    expect(second.ciphertext).not.toBe(first.ciphertext)
    expect(rebuild(second)).not.toBe(rebuild(first))
  })

  it("produces a distinct IV across many calls", () => {
    const ivs = new Set(
      Array.from({ length: 64 }, () => parts(encryptSecret(PLAINTEXT)).iv)
    )

    expect(ivs.size).toBe(64)
  })

  it("uses a 12-byte IV and a 16-byte tag", () => {
    const p = parts(encryptSecret(PLAINTEXT))

    expect(p.version).toBe("v1")
    expect(Buffer.from(p.iv, "base64url")).toHaveLength(12)
    expect(Buffer.from(p.tag, "base64url")).toHaveLength(16)
  })

  it("refuses to encrypt an empty secret", () => {
    expect(() => encryptSecret("")).toThrow(/empty/i)
  })
})

/**
 * Authentication on decrypt. GCM that does not verify its tag is unauthenticated
 * encryption wearing a reassuring name: an attacker who can write to the column
 * can flip bits in the ciphertext and choose what the application decrypts to.
 *
 * Each case asserts a **throw**, never a changed return value, because
 * "returned something different" is exactly what a missing tag check looks like.
 */
describe("decryptSecret rejects tampering", () => {
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.ASSISTANT_SECRET_KEY
    process.env.ASSISTANT_SECRET_KEY = KEY_HEX
  })

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.ASSISTANT_SECRET_KEY
    } else {
      process.env.ASSISTANT_SECRET_KEY = previousKey
    }
  })

  it("throws when the ciphertext is tampered with", () => {
    const p = parts(encryptSecret(PLAINTEXT))
    const tampered = rebuild({ ...p, ciphertext: corrupt(p.ciphertext) })

    expect(tampered).not.toBe(rebuild(p))
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it("throws when the IV is tampered with", () => {
    const p = parts(encryptSecret(PLAINTEXT))
    const tampered = rebuild({ ...p, iv: corrupt(p.iv) })

    expect(tampered).not.toBe(rebuild(p))
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it("throws when the auth tag is tampered with", () => {
    const p = parts(encryptSecret(PLAINTEXT))
    const tampered = rebuild({ ...p, tag: corrupt(p.tag) })

    expect(tampered).not.toBe(rebuild(p))
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it("throws when the IV is the wrong length", () => {
    const p = parts(encryptSecret(PLAINTEXT))
    const shortIv = randomBytes(11).toString("base64url")

    expect(() => decryptSecret(rebuild({ ...p, iv: shortIv }))).toThrow()
  })

  it("throws when the auth tag is the wrong length", () => {
    const p = parts(encryptSecret(PLAINTEXT))
    const shortTag = randomBytes(15).toString("base64url")

    expect(() => decryptSecret(rebuild({ ...p, tag: shortTag }))).toThrow()
  })

  it("throws when the ciphertext is truncated", () => {
    const p = parts(encryptSecret(PLAINTEXT))
    const truncated = Buffer.from(p.ciphertext, "base64url")
      .subarray(0, 4)
      .toString("base64url")

    expect(() =>
      decryptSecret(rebuild({ ...p, ciphertext: truncated }))
    ).toThrow()
  })

  it("throws when the version prefix is wrong", () => {
    const p = parts(encryptSecret(PLAINTEXT))

    expect(() => decryptSecret(rebuild({ ...p, version: "v2" }))).toThrow()
  })

  it.each([
    ["empty", ""],
    ["not serialised at all", PLAINTEXT],
    ["too few segments", "v1.aaaa.bbbb"],
    ["too many segments", "v1.aaaa.bbbb.cccc.dddd"],
  ])("throws on a malformed value (%s)", (_label, value) => {
    expect(() => decryptSecret(value)).toThrow()
  })

  it("throws when decrypted under a different key", () => {
    const serialised = encryptSecret(PLAINTEXT)
    process.env.ASSISTANT_SECRET_KEY = OTHER_KEY_HEX

    expect(() => decryptSecret(serialised)).toThrow()
  })
})

/**
 * What a failure is allowed to say.
 *
 * An error that helpfully echoes what it was given is how a secret reaches a log
 * aggregator, and a stack trace is captured as readily as a message. Both are
 * checked, and so is the `cause` chain: re-throwing the underlying Node error
 * would be the easy mistake here, and Node's GCM errors have carried operand
 * detail before.
 */
describe("decryptSecret error messages leak nothing", () => {
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.ASSISTANT_SECRET_KEY
    process.env.ASSISTANT_SECRET_KEY = KEY_HEX
  })

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.ASSISTANT_SECRET_KEY
    } else {
      process.env.ASSISTANT_SECRET_KEY = previousKey
    }
  })

  /** Message, stack, and the whole `cause` chain, flattened to one string. */
  function everythingThrown(body: () => unknown): string {
    try {
      body()
    } catch (error: unknown) {
      const seen: string[] = []
      let current: unknown = error

      while (current instanceof Error && seen.length < 10) {
        seen.push(current.message, current.stack ?? "", String(current))
        current = current.cause
      }

      if (seen.length === 0) {
        seen.push(String(current))
      }

      return seen.join("\n")
    }

    throw new Error("Expected the call to throw, and it did not.")
  }

  it.each([
    [
      "tampered ciphertext",
      (p: ReturnType<typeof parts>) =>
        rebuild({ ...p, ciphertext: corrupt(p.ciphertext) }),
    ],
    [
      "tampered IV",
      (p: ReturnType<typeof parts>) => rebuild({ ...p, iv: corrupt(p.iv) }),
    ],
    [
      "tampered tag",
      (p: ReturnType<typeof parts>) => rebuild({ ...p, tag: corrupt(p.tag) }),
    ],
    ["a malformed value", () => `not-serialised-${PLAINTEXT}`],
  ])(
    "never mentions the plaintext, key or ciphertext when given %s",
    (_label, mangle) => {
      const p = parts(encryptSecret(PLAINTEXT))
      const thrown = everythingThrown(() => decryptSecret(mangle(p)))

      expect(thrown).not.toContain(PLAINTEXT)
      expect(thrown).not.toContain(KEY_HEX)
      expect(thrown).not.toContain(p.ciphertext)
      expect(thrown).not.toContain(p.iv)
      expect(thrown).not.toContain(p.tag)
    }
  )

  it("never mentions the key when the key itself is rejected", () => {
    process.env.ASSISTANT_SECRET_KEY = "c".repeat(63)

    const thrown = everythingThrown(() => encryptSecret(PLAINTEXT))

    expect(thrown).not.toContain("c".repeat(63))
    expect(thrown).toContain("ASSISTANT_SECRET_KEY")
  })
})

/**
 * Key handling. A missing or wrong-length key must be an error, never a silent
 * fallback: a built-in default key is the same as no encryption, with the extra
 * problem that it looks encrypted.
 */
describe("encryptSecret requires a usable key", () => {
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.ASSISTANT_SECRET_KEY
  })

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.ASSISTANT_SECRET_KEY
    } else {
      process.env.ASSISTANT_SECRET_KEY = previousKey
    }
  })

  it("throws when the key is missing", () => {
    delete process.env.ASSISTANT_SECRET_KEY

    expect(() => encryptSecret(PLAINTEXT)).toThrow(/ASSISTANT_SECRET_KEY/)
  })

  it("throws when the key is empty", () => {
    process.env.ASSISTANT_SECRET_KEY = ""

    expect(() => encryptSecret(PLAINTEXT)).toThrow(/ASSISTANT_SECRET_KEY/)
  })

  it.each([
    ["too short", "a".repeat(62)],
    ["too long", "a".repeat(66)],
    ["not hex", "z".repeat(64)],
  ])("throws when the key is %s", (_label, value) => {
    process.env.ASSISTANT_SECRET_KEY = value

    expect(() => encryptSecret(PLAINTEXT)).toThrow(/ASSISTANT_SECRET_KEY/)
  })

  it("throws on decrypt too, rather than returning plaintext", () => {
    process.env.ASSISTANT_SECRET_KEY = KEY_HEX
    const serialised = encryptSecret(PLAINTEXT)

    delete process.env.ASSISTANT_SECRET_KEY

    expect(() => decryptSecret(serialised)).toThrow(/ASSISTANT_SECRET_KEY/)
  })
})

describe("secretsMatch", () => {
  it("matches identical secrets", () => {
    expect(secretsMatch(PLAINTEXT, PLAINTEXT)).toBe(true)
  })

  it("rejects a one-character difference of the same length", () => {
    expect(secretsMatch(PLAINTEXT, `${PLAINTEXT.slice(0, -1)}X`)).toBe(false)
  })

  it("rejects differing lengths without throwing", () => {
    expect(secretsMatch(PLAINTEXT, `${PLAINTEXT}extra`)).toBe(false)
    expect(secretsMatch("", PLAINTEXT)).toBe(false)
  })

  it("matches two empty strings", () => {
    expect(secretsMatch("", "")).toBe(true)
  })
})
