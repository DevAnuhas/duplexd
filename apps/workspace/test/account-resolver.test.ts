import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * The one resolver that answers "which account is this request acting as".
 *
 * Exactly one thing is mocked here, and it is not the thing under test:
 * `next/headers`, which needs a Next request scope that does not exist in a test
 * process. Everything else is real — the real Better Auth session lookup, the
 * real database, the real session cookie minted by a real signup. The mock's
 * whole job is to hand `getCurrentAccount` the same `Headers` a request would.
 *
 * Mocking the session itself would be the worthless version of this test: it
 * would assert that a stub returns what the stub was told to return, and would
 * stay green if the account id stopped being carried on the session at all.
 */

const requestHeaders = { current: new Headers() }

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}))

const { closeDb } = await import("@/db/client")
const { getCurrentAccount, requireCurrentAccount } =
  await import("@/lib/account")
const { signUpNewAccount, signIn, cookieHeaderFrom } =
  await import("./helpers/auth.ts")
const { isDatabaseConfigured } = await import("./helpers/environment.ts")

type SignedUp = Awaited<ReturnType<typeof signUpNewAccount>>

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

afterAll(async () => {
  await closeDb()
})

describeDatabase("getCurrentAccount", () => {
  let first: SignedUp
  let second: SignedUp

  beforeAll(async () => {
    first = await signUpNewAccount()
    second = await signUpNewAccount()
  })

  function actAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie })
  }

  it("resolves the account of the signed-in user", async () => {
    actAs(first.cookie)

    expect(await getCurrentAccount()).toStrictEqual({
      accountId: first.accountId,
      userId: first.userId,
    })
  })

  it("resolves a different account for a different session", async () => {
    actAs(second.cookie)

    const resolved = await getCurrentAccount()

    expect(resolved?.accountId).toBe(second.accountId)
    expect(resolved?.accountId).not.toBe(first.accountId)
  })

  it("returns null with no cookie at all", async () => {
    actAs("")

    expect(await getCurrentAccount()).toBeNull()
  })

  it("returns null for a forged session token", async () => {
    actAs("better-auth.session_token=not-a-real-token")

    expect(await getCurrentAccount()).toBeNull()
  })

  /**
   * The account id comes from the server-side session and from nowhere the
   * caller can reach. A header or query parameter naming another account must
   * change nothing — this is the shape of attack the single resolver exists to
   * make impossible.
   */
  it("ignores an account id supplied by the caller", async () => {
    requestHeaders.current = new Headers({
      cookie: first.cookie,
      "x-account-id": second.accountId,
      "x-accountid": second.accountId,
      accountid: second.accountId,
    })

    expect((await getCurrentAccount())?.accountId).toBe(first.accountId)
  })

  it("resolves the account from a freshly signed-in session too", async () => {
    const response = await signIn(first.email, first.password)

    expect(response.ok).toBe(true)
    actAs(cookieHeaderFrom(response))

    expect((await getCurrentAccount())?.accountId).toBe(first.accountId)
  })
})

describeDatabase("requireCurrentAccount", () => {
  let signedUp: SignedUp

  beforeAll(async () => {
    signedUp = await signUpNewAccount()
  })

  it("returns the account when there is a session", async () => {
    requestHeaders.current = new Headers({ cookie: signedUp.cookie })

    expect((await requireCurrentAccount()).accountId).toBe(signedUp.accountId)
  })

  it("throws when there is none, rather than returning a falsy account", async () => {
    requestHeaders.current = new Headers()

    await expect(requireCurrentAccount()).rejects.toThrow(/not authenticated/i)
  })
})
