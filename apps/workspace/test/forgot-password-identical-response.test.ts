import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Forgot-password tells everyone the same thing.
 *
 * Better Auth's `request-password-reset` endpoint already returns an identical
 * body for a known and an unknown address. This form is the place that could
 * undo it, because it is the only layer that can see *how* the call went —
 * so the property worth testing is that it renders one sentence no matter what
 * comes back, including when nothing comes back at all.
 *
 * Three outcomes are driven through the real component: a resolved call, a
 * resolve carrying Better Auth's error-shaped body, and a rejected promise. If
 * any of them produced different copy, the pair of messages side by side would
 * tell an attacker which addresses are registered — "we couldn't find that
 * account" next to "our mail provider is down" is an enumeration oracle
 * assembled out of two individually reasonable error messages.
 *
 * **One thing is mocked and it is not the subject:** `@/lib/auth-client`, which
 * is the network boundary and the only way to choose an outcome. Everything
 * else is real — the real component, the real React Hook Form wiring, the real
 * Zod resolver, a real DOM.
 *
 * The mock is also the load-bearing control. Every assertion below would be
 * satisfied by four renders of an unsubmitted form, so each case asserts the
 * call actually happened; without that, a typing helper that silently failed to
 * reach React would leave this file green while exercising nothing. That is not
 * hypothetical — it is the failure mode `test/helpers/assistant-form/render.ts`
 * exists to document.
 */

/** Distinctive, so its absence from the rendered text means something. */
const NETWORK_FAILURE = "CANARY-mail-provider-unreachable"

const requestPasswordReset = vi.fn()

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    requestPasswordReset: (...args: unknown[]) =>
      requestPasswordReset(...args) as unknown,
  },
}))

// Must be evaluated before anything pulls in React: it installs the DOM, and
// `react-dom` decides at import time which event machinery it can use. The
// helper's own header explains what breaks otherwise.
const { control, createElement, mount, submit, type } =
  await import("./helpers/assistant-form/render.ts")
const { ForgotPasswordForm } =
  await import("@/app/forgot-password/forgot-password-form")

const ADDRESS = "person@example.com"
const UNKNOWN_ADDRESS = "nobody-here@example.com"

/** Better Auth's shape for a call that completed but reported a problem. */
const ERROR_BODY = {
  data: null,
  error: { status: 404, statusText: "NOT_FOUND", message: "User not found" },
}

/**
 * Mounts the form, submits `email`, and returns what the page then reads as.
 *
 * The whole container is captured rather than one element, because copy that
 * differs anywhere on the page is just as much of a tell as copy that differs
 * inside the status line.
 */
async function submitAddress(email: string): Promise<string> {
  const mounted = await mount(createElement(ForgotPasswordForm))

  await type(control(mounted, "email"), email)
  await submit(mounted)

  const rendered = mounted.container.textContent ?? ""

  mounted.unmount()

  return rendered
}

beforeEach(() => {
  requestPasswordReset.mockReset()
})

describe("the forgot-password form", () => {
  it("reaches the client with the submitted address", async () => {
    requestPasswordReset.mockResolvedValue({ data: {}, error: null })

    await submitAddress(ADDRESS)

    expect(
      requestPasswordReset,
      "the form never called the client, so every assertion in this file " +
        "would be comparing unsubmitted forms"
    ).toHaveBeenCalledTimes(1)

    expect(requestPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({ email: ADDRESS })
    )
  })

  it("does not submit an address the schema rejects", async () => {
    requestPasswordReset.mockResolvedValue({ data: {}, error: null })

    const rendered = await submitAddress("not-an-address")

    expect(
      requestPasswordReset,
      "an invalid address reached the network"
    ).not.toHaveBeenCalled()

    expect(rendered).toMatch(/valid email/i)
  })

  /**
   * The schema trims, and **the trimmed value is what reaches the network**.
   *
   * `auth-schemas.test.ts` proves the schema normalizes the address; this is
   * the other half, and the half that matters to the person locked out. A
   * pasted address with a trailing space is the case the trim exists for, and
   * nothing else asserts that `zodResolver` hands the *parsed* value to the
   * submit handler rather than the raw input. If it ever handed over the raw
   * value, every schema test would still pass and Better Auth would be asked
   * about an address with a space in it.
   */
  it.each([
    ["a trailing space", `${ADDRESS} `],
    ["surrounding spaces", `  ${ADDRESS}  `],
    ["a tab and a newline", `\t${ADDRESS}\n`],
  ])(
    "submits the trimmed address when it was pasted with %s",
    async (_label, typed) => {
      requestPasswordReset.mockResolvedValue({ data: {}, error: null })

      await submitAddress(typed)

      expect(requestPasswordReset).toHaveBeenCalledTimes(1)
      expect(
        requestPasswordReset,
        "the padding reached the network, so the schema trimmed but the form did not"
      ).toHaveBeenCalledWith(expect.objectContaining({ email: ADDRESS }))
    }
  )

  /**
   * The property itself.
   *
   * Each outcome is rendered independently and the resulting text compared
   * byte-for-byte against the first. `toBe` on the whole string rather than a
   * looser match is deliberate: a difference in punctuation or a trailing
   * clause is exactly the kind of drift that would separate the two cases.
   */
  it("renders byte-identical copy whatever the client does", async () => {
    const outcomes: [string, () => void, string][] = [
      [
        "a resolved call for a known address",
        () => requestPasswordReset.mockResolvedValue({ data: {}, error: null }),
        ADDRESS,
      ],
      [
        "a resolved call reporting that the account does not exist",
        () => requestPasswordReset.mockResolvedValue(ERROR_BODY),
        UNKNOWN_ADDRESS,
      ],
      [
        "a rejected call, because the provider is down",
        () =>
          requestPasswordReset.mockRejectedValue(new Error(NETWORK_FAILURE)),
        ADDRESS,
      ],
      [
        "a rejected call for an address that does not exist",
        () =>
          requestPasswordReset.mockRejectedValue(new Error(NETWORK_FAILURE)),
        UNKNOWN_ADDRESS,
      ],
    ]

    const rendered: Record<string, string> = {}

    for (const [label, arrange, email] of outcomes) {
      requestPasswordReset.mockReset()
      arrange()

      rendered[label] = await submitAddress(email)

      expect(
        requestPasswordReset,
        `${label}: the client was never called, so this case proved nothing`
      ).toHaveBeenCalledTimes(1)
    }

    const [first, ...rest] = Object.entries(rendered)

    expect(first).toBeDefined()

    for (const [label, text] of rest) {
      expect(text, `${label} rendered different copy`).toBe(first?.[1])
    }
  })

  /**
   * What the identical copy actually says.
   *
   * Byte-equality alone would be satisfied by four blank pages, so the content
   * is pinned too: it must confirm the request without asserting an account
   * exists, and it must never mention what went wrong.
   */
  it("confirms the request without claiming the account exists", async () => {
    requestPasswordReset.mockResolvedValue({ data: {}, error: null })

    const rendered = await submitAddress(ADDRESS)

    expect(rendered).toMatch(/if an account exists/i)
    expect(
      rendered,
      "the copy promises delivery, which is a claim it cannot make"
      // "check your inbox" asserts something that is false for a mistyped
      // address; "if an account exists" does not.
    ).not.toMatch(/check your inbox/i)
  })

  /**
   * The failure is not leaked, and the page is not blank either.
   *
   * A canary that is simply absent proves nothing on its own — a component that
   * rendered nothing at all would satisfy it. The positive half is asserted
   * alongside: the reassurance survived.
   */
  it("leaks nothing about a provider failure", async () => {
    requestPasswordReset.mockRejectedValue(new Error(NETWORK_FAILURE))

    const rendered = await submitAddress(ADDRESS)

    expect(requestPasswordReset).toHaveBeenCalledTimes(1)
    expect(rendered, "the failure reached the page").not.toContain(
      NETWORK_FAILURE
    )
    expect(rendered, "the page rendered nothing at all").toMatch(
      /if an account exists/i
    )
  })

  /**
   * The address itself is not echoed back.
   *
   * A page that says "we've sent a link to kevin@example.com" is a different
   * kind of leak — it confirms nothing about existence, but it reflects
   * attacker-supplied text straight back into the document.
   */
  it("does not echo the submitted address", async () => {
    requestPasswordReset.mockResolvedValue({ data: {}, error: null })

    const rendered = await submitAddress(UNKNOWN_ADDRESS)

    expect(rendered).not.toContain(UNKNOWN_ADDRESS)
  })
})
