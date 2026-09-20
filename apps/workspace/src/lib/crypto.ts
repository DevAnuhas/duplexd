import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

import { requireEncryptionKey } from "@/db/env"

/**
 * AES-256-GCM for the customer's webhook secret.
 *
 * The secret belongs to the customer and the platform is holding it on their
 * behalf, which makes this the sharpest obligation in the schema: it is
 * encrypted at rest, decrypted only where a call needs it, and never returned
 * by an API, rendered into a page, written to a log, or included in an error.
 *
 * Nothing here ever puts the plaintext, the key, or the ciphertext into an
 * error message. A decrypt failure says that it failed and nothing else — an
 * error that helpfully echoes what it was given is how a secret reaches a log
 * aggregator.
 */

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16

/** Serialised form: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
const VERSION = "v1"

/**
 * Encrypts `plaintext` under the configured key.
 *
 * A fresh random IV is generated per call, so encrypting the same plaintext
 * twice produces different ciphertext. A fixed or derived-from-plaintext IV
 * would leak equality between secrets and, with GCM specifically, reusing an
 * IV under the same key is catastrophic rather than merely untidy.
 */
export function encryptSecret(plaintext: string): string {
  if (plaintext === "") {
    throw new Error("Refusing to encrypt an empty secret.")
  }

  const key = requireEncryptionKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

/**
 * Decrypts a value produced by {@link encryptSecret}.
 *
 * Tampering with the ciphertext, the IV, or the tag makes this throw rather
 * than return garbage: GCM's authentication tag is verified before any
 * plaintext is returned. Using GCM without checking the tag is unauthenticated
 * encryption wearing a reassuring name.
 */
export function decryptSecret(serialised: string): string {
  const parts = serialised.split(".")

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Stored secret is not in the expected format.")
  }

  const key = requireEncryptionKey()

  try {
    const iv = Buffer.from(parts[1]!, "base64url")
    const tag = Buffer.from(parts[2]!, "base64url")
    const ciphertext = Buffer.from(parts[3]!, "base64url")

    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error("length")
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    // Deliberately opaque, and deliberately not re-throwing the original: the
    // underlying error can carry fragments of what it was decrypting.
    throw new Error("Stored secret could not be decrypted.")
  }
}

/**
 * Constant-time comparison for secret material.
 *
 * `===` on secrets leaks their contents through timing, one byte at a time.
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch;
 * a secret's length is not the part worth protecting.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")

  if (left.length !== right.length) {
    return false
  }

  return timingSafeEqual(left, right)
}
