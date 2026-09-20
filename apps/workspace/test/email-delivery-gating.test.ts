import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  emailDeliveryConfigured,
  readEmailFrom,
  readResendApiKey,
} from "@/db/env"

/**
 * The one boolean standing between a locked-out person and a dead button.
 *
 * `emailDeliveryConfigured()` decides three things, and all three are worse
 * when it is wrong in the *optimistic* direction:
 *
 *  - `/forgot-password` calls `notFound()` when it is false;
 *  - `/reset-password` does the same;
 *  - `/sign-in` renders "Forgot your password?" only when it is true.
 *
 * A false negative hides a working feature, which is annoying. A false positive
 * offers a reset to somebody who cannot sign in, collects their address, tells
 * them a link is coming, and sends nothing — the failure lands on the person
 * with the least ability to do anything about it. So the cases that matter most
 * here are the ones where a variable is *present but useless*: set to the empty
 * string, or to whitespace that a `.env` line picked up by accident.
 *
 * `process.env` is snapshotted and restored around every test. Mutating it
 * without restoring would leak into whatever file vitest runs next, and with
 * `fileParallelism` off that is a real ordering dependency rather than a
 * theoretical one.
 */

const VARIABLES = ["RESEND_API_KEY", "EMAIL_FROM"] as const

/** A plausible key and address, so a passing case fails for no other reason. */
const PRESENT: Readonly<Record<(typeof VARIABLES)[number], string>> = {
  RESEND_API_KEY: "re_test_only_placeholder_not_a_real_key",
  EMAIL_FROM: "duplexd <auth@example.invalid>",
}

/** Values that are *present* but carry nothing usable. */
const BLANK = ["", " ", "   ", "\t", "\n", " \t\n "] as const

let saved: Partial<Record<string, string | undefined>> = {}

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]))
})

afterEach(() => {
  for (const name of VARIABLES) {
    const value = saved[name]

    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
})

/**
 * Sets the two variables for one case.
 *
 * `null` means "absent" and is deleted rather than set to the empty string —
 * the two are different inputs to this function and both have to be covered,
 * so conflating them in the helper would quietly halve the matrix.
 */
function setEnvironment(key: string | null, from: string | null): void {
  if (key === null) {
    delete process.env.RESEND_API_KEY
  } else {
    process.env.RESEND_API_KEY = key
  }

  if (from === null) {
    delete process.env.EMAIL_FROM
  } else {
    process.env.EMAIL_FROM = from
  }
}

describe("emailDeliveryConfigured", () => {
  it("is true when both variables carry a value", () => {
    setEnvironment(PRESENT.RESEND_API_KEY, PRESENT.EMAIL_FROM)

    expect(emailDeliveryConfigured()).toBe(true)
  })

  it("is false when neither is set", () => {
    setEnvironment(null, null)

    expect(emailDeliveryConfigured()).toBe(false)
  })

  it.each([
    ["the API key is absent", null, PRESENT.EMAIL_FROM],
    ["the from address is absent", PRESENT.RESEND_API_KEY, null],
  ])("is false when %s", (_label, key, from) => {
    setEnvironment(key, from)

    expect(emailDeliveryConfigured()).toBe(false)
  })

  /**
   * The cases that actually bite.
   *
   * A variable declared in a `.env` file with nothing after the `=`, or with a
   * stray space, is *set* as far as `process.env` is concerned. Treating that
   * as configured is how a deployment ends up offering a reset it cannot send.
   */
  describe.each(BLANK)("with a blank value (%j)", (blank) => {
    it("is false when the API key is blank", () => {
      setEnvironment(blank, PRESENT.EMAIL_FROM)

      expect(emailDeliveryConfigured()).toBe(false)
    })

    it("is false when the from address is blank", () => {
      setEnvironment(PRESENT.RESEND_API_KEY, blank)

      expect(emailDeliveryConfigured()).toBe(false)
    })

    it("is false when both are blank", () => {
      setEnvironment(blank, blank)

      expect(emailDeliveryConfigured()).toBe(false)
    })
  })

  /**
   * The positive control for the blank cases above.
   *
   * Without it, every "is false" assertion would also be satisfied by a
   * function that had stopped working and returned `false` unconditionally —
   * and the whole block would pass while proving nothing.
   */
  it("is true again once real values are restored", () => {
    setEnvironment("   ", "   ")
    expect(emailDeliveryConfigured()).toBe(false)

    setEnvironment(PRESENT.RESEND_API_KEY, PRESENT.EMAIL_FROM)
    expect(emailDeliveryConfigured()).toBe(true)
  })

  /** Surrounding whitespace is trimmed off, not treated as absence. */
  it("is true when the values are padded but real", () => {
    setEnvironment(`  ${PRESENT.RESEND_API_KEY}  `, `\t${PRESENT.EMAIL_FROM}\n`)

    expect(emailDeliveryConfigured()).toBe(true)
  })
})

/**
 * The two readers underneath, checked separately.
 *
 * `emailDeliveryConfigured()` is their conjunction, so a bug in one is visible
 * through it — but only as "false", which is also what a correct answer looks
 * like for five of the cases above. Asserting the readers directly is what
 * distinguishes "absent" from "returned the wrong string".
 */
describe("the readers underneath", () => {
  it("return the trimmed value when it is real", () => {
    setEnvironment(`  ${PRESENT.RESEND_API_KEY}  `, `  ${PRESENT.EMAIL_FROM}  `)

    expect(readResendApiKey()).toBe(PRESENT.RESEND_API_KEY)
    expect(readEmailFrom()).toBe(PRESENT.EMAIL_FROM)
  })

  it.each(BLANK)("return null for a blank value (%j)", (blank) => {
    setEnvironment(blank, blank)

    expect(readResendApiKey()).toBeNull()
    expect(readEmailFrom()).toBeNull()
  })

  it("return null when absent", () => {
    setEnvironment(null, null)

    expect(readResendApiKey()).toBeNull()
    expect(readEmailFrom()).toBeNull()
  })

  /**
   * Neither reader may hand back the credential when it is unusable. A caller
   * that received `''` instead of `null` would pass a truthiness check in some
   * future call site and try to send with an empty key.
   */
  it("never return an empty string", () => {
    for (const blank of BLANK) {
      setEnvironment(blank, blank)

      expect(readResendApiKey()).not.toBe("")
      expect(readEmailFrom()).not.toBe("")
    }
  })
})
