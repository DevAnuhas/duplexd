import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { validateServerUrl } from "@/lib/validate"

import {
  requireAuthSecret,
  requireAuthUrl,
  resolveAuthBaseUrl,
  requireDatabaseUrl,
  requireEncryptionKey,
  requirePipecatApiKey,
  readCallSweepToken,
  resolveSandboxAgentApiBase,
  sandboxExecutionConfigured,
} from "@/db/env"

/**
 * The fail-closed environment guards.
 *
 * `DATABASE_URL` is the sharp one. `psql` and libpq-style clients treat an empty
 * connection argument as "use the defaults" and connect to the local unix socket
 * on 5432 — so an empty variable does not fail, it quietly talks to whatever
 * database happens to be running on the machine. That has already fired in this
 * repository once, when a `.env` line broke shell parsing and left the variable
 * empty. Every case below is a way that variable can arrive not-set.
 *
 * The host is deliberately never asserted on. A Neon branch is the documented
 * default and any PostgreSQL 17 or newer works; a guard that rejected a local
 * server would contradict that, so the tests check for "absent", never "wrong
 * kind of database".
 */

const VARIABLES = [
  "DATABASE_URL",
  "ASSISTANT_SECRET_KEY",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "PIPECAT_API_KEY",
  "CALL_SWEEP_TOKEN",
] as const

/**
 * Documented in `.env.example`, read directly, and deliberately unguarded.
 *
 * Each one must be **absent-safe**: unset has to mean the safe behaviour, not
 * an error and not the permissive behaviour. That is what justifies it having
 * no `require…()` guard, and it is asserted rather than asserted about — see
 * the absent-safe test below.
 */
const OPTIONAL_VARIABLES = [
  "ALLOW_LOOPBACK_SERVER_URL",
  // The Sandbox provider binding. Absent, `readSandboxProviderEnvironment()`
  // returns null and `sandboxExecutionConfigured()` is false — so a deployment
  // missing any of them does not dispatch calls at all. Absence costs a
  // feature, never a call placed against a half-configured provider.
  "PIPECAT_PRIVATE_API_KEY",
  "PIPECAT_ORGANIZATION_ID",
  "PIPECAT_SERVICE_ID",
  "PIPECAT_DEPLOYMENT_ID",
  // Absent, the agent callback origin is the workspace's own `BETTER_AUTH_URL`,
  // which is correct everywhere except a local tunnel. Absence is production.
  "SANDBOX_AGENT_API_BASE",
] as const

/**
 * Injected by Vercel, never by us, and deliberately **not** in `VARIABLES`.
 *
 * They belong to no `.env.example` line because nobody sets them: the platform
 * supplies them per deployment. Adding them to `VARIABLES` would fail the
 * `.env.example` contract test below, which is the correct outcome — that test
 * exists to catch a required variable the file forgot, and these are not
 * required variables.
 *
 * They are cleared before every test rather than only saved. A machine with
 * `VERCEL_ENV` already exported would otherwise change what the guards below
 * do, and the failure would look like a flaky test rather than a leaked
 * environment.
 */
const PLATFORM_VARIABLES = [
  "VERCEL_ENV",
  "VERCEL_BRANCH_URL",
  "VERCEL_URL",
] as const

describe("environment guards", () => {
  let saved: Partial<
    Record<
      (typeof VARIABLES)[number] | (typeof PLATFORM_VARIABLES)[number],
      string | undefined
    >
  > = {}

  beforeEach(() => {
    saved = Object.fromEntries(
      [...VARIABLES, ...PLATFORM_VARIABLES].map((name) => [
        name,
        process.env[name],
      ])
    )

    for (const name of PLATFORM_VARIABLES) {
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const name of [...VARIABLES, ...PLATFORM_VARIABLES]) {
      const value = saved[name]

      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  describe("requireDatabaseUrl", () => {
    it.each([
      ["unset", undefined],
      ["the empty string", ""],
      ["only whitespace", "   "],
    ])("throws when DATABASE_URL is %s", (_label, value) => {
      if (value === undefined) {
        delete process.env.DATABASE_URL
      } else {
        process.env.DATABASE_URL = value
      }

      expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/)
    })

    it("names the variable and says it is never defaulted", () => {
      delete process.env.DATABASE_URL

      expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/)
      expect(() => requireDatabaseUrl()).toThrow(/unset or empty/i)
    })

    it("returns the value when it is set", () => {
      process.env.DATABASE_URL = "postgres://example.invalid:5432/db"

      expect(requireDatabaseUrl()).toBe("postgres://example.invalid:5432/db")
    })

    /**
     * A local server is a legitimate configuration, so this must not be
     * rejected. The Planner's ruling: any PostgreSQL 17+ works and nothing
     * special-cases Neon, which means nothing may special-case localhost either.
     */
    it("accepts a local connection string rather than inspecting the host", () => {
      process.env.DATABASE_URL = "postgres://localhost:5432/anything"

      expect(requireDatabaseUrl()).toBe("postgres://localhost:5432/anything")
    })
  })

  describe("readCallSweepToken", () => {
    it.each([undefined, "", "   "])(
      "reports an absent or blank value as unconfigured: %s",
      (value) => {
        if (value === undefined) delete process.env.CALL_SWEEP_TOKEN
        else process.env.CALL_SWEEP_TOKEN = value
        expect(readCallSweepToken()).toBeNull()
      }
    )

    it("returns a configured token without exposing a fallback", () => {
      process.env.CALL_SWEEP_TOKEN = "  synthetic-sweep-token  "
      expect(readCallSweepToken()).toBe("synthetic-sweep-token")
    })
  })

  describe("requireEncryptionKey", () => {
    it.each([
      ["unset", undefined],
      ["the empty string", ""],
      ["only whitespace", "  "],
    ])("throws when ASSISTANT_SECRET_KEY is %s", (_label, value) => {
      if (value === undefined) {
        delete process.env.ASSISTANT_SECRET_KEY
      } else {
        process.env.ASSISTANT_SECRET_KEY = value
      }

      expect(() => requireEncryptionKey()).toThrow(/ASSISTANT_SECRET_KEY/)
    })

    it.each([
      ["63 hex characters", "a".repeat(63)],
      ["65 hex characters", "a".repeat(65)],
      ["32 raw bytes rather than hex", "x".repeat(32)],
      ["non-hex characters", "g".repeat(64)],
    ])("throws when the key is %s", (_label, value) => {
      process.env.ASSISTANT_SECRET_KEY = value

      expect(() => requireEncryptionKey()).toThrow(/ASSISTANT_SECRET_KEY/)
    })

    it("returns 32 bytes for a valid key", () => {
      process.env.ASSISTANT_SECRET_KEY = "ab".repeat(32)

      const key = requireEncryptionKey()

      expect(key).toHaveLength(32)
      expect(key.toString("hex")).toBe("ab".repeat(32))
    })

    it("accepts upper-case hex and surrounding whitespace", () => {
      process.env.ASSISTANT_SECRET_KEY = `  ${"AB".repeat(32)}  `

      expect(requireEncryptionKey().toString("hex")).toBe("ab".repeat(32))
    })

    /** A default key is the same as no encryption, and harder to notice. */
    it("never falls back to a default key", () => {
      delete process.env.ASSISTANT_SECRET_KEY

      expect(() => requireEncryptionKey()).toThrow()
    })
  })

  describe("requireAuthSecret", () => {
    it.each([
      ["unset", undefined],
      ["the empty string", ""],
      ["only whitespace", " "],
    ])("throws when BETTER_AUTH_SECRET is %s", (_label, value) => {
      if (value === undefined) {
        delete process.env.BETTER_AUTH_SECRET
      } else {
        process.env.BETTER_AUTH_SECRET = value
      }

      expect(() => requireAuthSecret()).toThrow(/BETTER_AUTH_SECRET/)
    })

    it("returns the value when it is set", () => {
      process.env.BETTER_AUTH_SECRET = "placeholder-value-for-this-test"

      expect(requireAuthSecret()).toBe("placeholder-value-for-this-test")
    })
  })

  /**
   * `BETTER_AUTH_URL` is required rather than optional, and the reason is worth
   * stating because the optional version looks harmless.
   *
   * Better Auth will derive its base URL from the incoming request when this is
   * absent. That hands the origin used to build callback and cookie URLs to
   * whatever `Host` header arrives — and behind a proxy, which is exactly how
   * this deploys, the application does not control that header. A deployment
   * should state its own identity rather than infer it from traffic.
   *
   * It is also what keeps `.env.example` honest under contract item 19: every
   * variable listed there fails at start when missing, so the file is a complete
   * account of what the app needs rather than a mix of requirements and
   * suggestions. A variable that is listed but optional makes the reader guess
   * which of the others are real.
   */
  describe("requireAuthUrl", () => {
    it.each([
      ["unset", undefined],
      ["the empty string", ""],
      ["only whitespace", "   "],
    ])("throws when BETTER_AUTH_URL is %s", (_label, value) => {
      if (value === undefined) {
        delete process.env.BETTER_AUTH_URL
      } else {
        process.env.BETTER_AUTH_URL = value
      }

      expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/)
    })

    it("names the variable and says it is not derived from the request", () => {
      delete process.env.BETTER_AUTH_URL

      expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/)
      expect(() => requireAuthUrl()).toThrow(/unset or empty/i)
      expect(() => requireAuthUrl()).toThrow(/not derived\s+from the request/i)
    })

    it("returns the value when it is set", () => {
      process.env.BETTER_AUTH_URL = "https://workspace.example.invalid"

      expect(requireAuthUrl()).toBe("https://workspace.example.invalid")
    })

    it("trims surrounding whitespace", () => {
      process.env.BETTER_AUTH_URL = "  http://localhost:3000  "

      expect(requireAuthUrl()).toBe("http://localhost:3000")
    })

    /**
     * No fallback of any kind. A default of `http://localhost:3000` would be the
     * tempting shape and the dangerous one: it would work everywhere in
     * development and mint cookies for the wrong origin in production, which is
     * the failure that does not show up until it is live.
     */
    it("never falls back to a default origin", () => {
      delete process.env.BETTER_AUTH_URL

      expect(() => requireAuthUrl()).toThrow()
    })

    /**
     * The one exception, and why it does not contradict the rule above.
     *
     * A Vercel preview origin cannot be configured in advance: every pull
     * request gets a different generated domain, so there is no value to put
     * in the Preview scope that matches the origin the reviewer opens. Leaving
     * it unset makes every preview 500 at the instrumentation hook; pasting a
     * guess is worse, because `BETTER_AUTH_URL` decides the cookie domain and
     * the `__Secure-` prefix, so a wrong origin signs in and then silently
     * fails to keep the session.
     *
     * `VERCEL_BRANCH_URL` is **not** the request's `Host` header. It is a
     * platform-injected variable naming this deployment, which is exactly the
     * distinction the rule above is drawing: the deployment still states its
     * own identity, it just reads that identity from the platform instead of a
     * dashboard field. The branch URL is chosen over the per-deployment
     * `VERCEL_URL` because it is stable across redeploys of the same pull
     * request, so a session survives a push.
     *
     * Production is deliberately excluded. A production deployment missing
     * `BETTER_AUTH_URL` must still fail loudly rather than quietly mint
     * cookies for a `vercel.app` domain instead of the real one.
     */
    describe("the Vercel preview fallback", () => {
      it("derives the origin from VERCEL_BRANCH_URL on a preview deployment", () => {
        delete process.env.BETTER_AUTH_URL
        process.env.VERCEL_ENV = "preview"
        process.env.VERCEL_BRANCH_URL =
          "duplexd-git-fix-preview-auth-url-anuhas-projects.vercel.app"

        expect(requireAuthUrl()).toBe(
          "https://duplexd-git-fix-preview-auth-url-anuhas-projects.vercel.app"
        )
      })

      it("prefers an explicit BETTER_AUTH_URL over the preview fallback", () => {
        process.env.BETTER_AUTH_URL = "https://chosen.example.invalid"
        process.env.VERCEL_ENV = "preview"
        process.env.VERCEL_BRANCH_URL = "ignored.vercel.app"

        expect(requireAuthUrl()).toBe("https://chosen.example.invalid")
      })

      it("still throws on production even when VERCEL_BRANCH_URL is present", () => {
        delete process.env.BETTER_AUTH_URL
        process.env.VERCEL_ENV = "production"
        process.env.VERCEL_BRANCH_URL = "duplexd-anuhas-projects.vercel.app"

        expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/)
      })

      it("still throws when VERCEL_ENV is absent", () => {
        delete process.env.BETTER_AUTH_URL
        process.env.VERCEL_BRANCH_URL = "duplexd-git-branch.vercel.app"

        expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/)
      })

      it.each([
        ["unset", undefined],
        ["the empty string", ""],
        ["only whitespace", "   "],
      ])(
        "still throws on a preview when VERCEL_BRANCH_URL is %s",
        (_label, value) => {
          delete process.env.BETTER_AUTH_URL
          process.env.VERCEL_ENV = "preview"

          if (value === undefined) {
            delete process.env.VERCEL_BRANCH_URL
          } else {
            process.env.VERCEL_BRANCH_URL = value
          }

          expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/)
        }
      )

      it("trims the branch host before building the origin", () => {
        delete process.env.BETTER_AUTH_URL
        process.env.VERCEL_ENV = "preview"
        process.env.VERCEL_BRANCH_URL = "  duplexd-git-branch.vercel.app  "

        expect(requireAuthUrl()).toBe("https://duplexd-git-branch.vercel.app")
      })

      it("falls back to the deployment host when only VERCEL_URL is present", () => {
        delete process.env.BETTER_AUTH_URL
        process.env.VERCEL_ENV = "preview"
        delete process.env.VERCEL_BRANCH_URL
        process.env.VERCEL_URL = "duplexd-abc123.vercel.app"

        expect(requireAuthUrl()).toBe("https://duplexd-abc123.vercel.app")
      })
    })
  })

  /**
   * Better Auth's origin check compares the request's `Origin` against the
   * configured base URL, and **a Vercel preview is reachable on two hostnames
   * that both legitimately serve it**: the stable branch URL and the
   * per-deployment URL. Vercel's dashboard and pull-request comments link the
   * per-deployment one, so that is the host a reviewer actually opens.
   *
   * Pinning the base URL to either one rejects the other with `403 Invalid
   * origin`. That is not hypothetical — it is what a single-host preview
   * fallback produced, and the failure was invisible to a check that requested
   * the branch URL with a matching `Origin` header, which is the one path the
   * fallback was designed for.
   *
   * So the base URL becomes **per-request but allowlisted**, using Better
   * Auth's `DynamicBaseURLConfig`, documented for exactly this case. The
   * distinction from "derived from the request" still holds: the host may
   * choose only between origins this deployment already knows about, both
   * injected by the platform. An arbitrary `Host` header cannot name an
   * origin.
   *
   * Production keeps a single explicit string. It has one hostname, so a
   * per-request base URL would add a header to the auth decision for no
   * benefit.
   */
  describe("resolveAuthBaseUrl", () => {
    it("allows both preview hostnames, preferring the branch URL as fallback", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_ENV = "preview"
      process.env.VERCEL_BRANCH_URL = "duplexd-git-branch.vercel.app"
      process.env.VERCEL_URL = "duplexd-abc123.vercel.app"

      expect(resolveAuthBaseUrl()).toStrictEqual({
        allowedHosts: [
          "duplexd-git-branch.vercel.app",
          "duplexd-abc123.vercel.app",
        ],
        protocol: "https",
        fallback: "https://duplexd-git-branch.vercel.app",
      })
    })

    it("returns the explicit origin as a plain string, not a dynamic config", () => {
      process.env.BETTER_AUTH_URL = "https://workspace.example.invalid"
      process.env.VERCEL_ENV = "preview"
      process.env.VERCEL_BRANCH_URL = "duplexd-git-branch.vercel.app"
      process.env.VERCEL_URL = "duplexd-abc123.vercel.app"

      expect(resolveAuthBaseUrl()).toBe("https://workspace.example.invalid")
    })

    it("lists only the hosts that are actually present", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_ENV = "preview"
      delete process.env.VERCEL_BRANCH_URL
      process.env.VERCEL_URL = "duplexd-abc123.vercel.app"

      expect(resolveAuthBaseUrl()).toStrictEqual({
        allowedHosts: ["duplexd-abc123.vercel.app"],
        protocol: "https",
        fallback: "https://duplexd-abc123.vercel.app",
      })
    })

    it("never widens beyond the two platform hosts", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_ENV = "preview"
      process.env.VERCEL_BRANCH_URL = "duplexd-git-branch.vercel.app"
      process.env.VERCEL_URL = "duplexd-abc123.vercel.app"

      const resolved = resolveAuthBaseUrl()

      expect(typeof resolved).toBe("object")
      const hosts = (resolved as { allowedHosts: string[] }).allowedHosts
      expect(hosts).toHaveLength(2)
      expect(hosts.some((host) => host.includes("*"))).toBe(false)
    })

    it("throws on production even with both platform hosts present", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_ENV = "production"
      process.env.VERCEL_BRANCH_URL = "duplexd-git-branch.vercel.app"
      process.env.VERCEL_URL = "duplexd-abc123.vercel.app"

      expect(() => resolveAuthBaseUrl()).toThrow(/BETTER_AUTH_URL/)
    })

    it("throws when VERCEL_ENV is absent", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_BRANCH_URL = "duplexd-git-branch.vercel.app"
      process.env.VERCEL_URL = "duplexd-abc123.vercel.app"

      expect(() => resolveAuthBaseUrl()).toThrow(/BETTER_AUTH_URL/)
    })

    it("throws on a preview with neither platform host", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_ENV = "preview"
      delete process.env.VERCEL_BRANCH_URL
      delete process.env.VERCEL_URL

      expect(() => resolveAuthBaseUrl()).toThrow(/BETTER_AUTH_URL/)
    })

    it("trims both hosts", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_ENV = "preview"
      process.env.VERCEL_BRANCH_URL = "  duplexd-git-branch.vercel.app  "
      process.env.VERCEL_URL = "  duplexd-abc123.vercel.app  "

      expect(resolveAuthBaseUrl()).toStrictEqual({
        allowedHosts: [
          "duplexd-git-branch.vercel.app",
          "duplexd-abc123.vercel.app",
        ],
        protocol: "https",
        fallback: "https://duplexd-git-branch.vercel.app",
      })
    })

    it("does not repeat a host when both variables name the same one", () => {
      delete process.env.BETTER_AUTH_URL
      process.env.VERCEL_ENV = "preview"
      process.env.VERCEL_BRANCH_URL = "duplexd-same.vercel.app"
      process.env.VERCEL_URL = "duplexd-same.vercel.app"

      expect(resolveAuthBaseUrl()).toStrictEqual({
        allowedHosts: ["duplexd-same.vercel.app"],
        protocol: "https",
        fallback: "https://duplexd-same.vercel.app",
      })
    })
  })

  describe("requirePipecatApiKey", () => {
    it.each([
      ["unset", undefined],
      ["the empty string", ""],
      ["only whitespace", "   "],
    ])("throws when PIPECAT_API_KEY is %s", (_label, value) => {
      if (value === undefined) {
        delete process.env.PIPECAT_API_KEY
      } else {
        process.env.PIPECAT_API_KEY = value
      }

      expect(() => requirePipecatApiKey()).toThrow(/PIPECAT_API_KEY/)
    })

    it("returns a configured key without exposing it elsewhere", () => {
      process.env.PIPECAT_API_KEY = "synthetic-pipecat-key-for-env-test"

      expect(requirePipecatApiKey()).toBe("synthetic-pipecat-key-for-env-test")
    })
  })

  /**
   * Reading at call time rather than module import is what lets `next build`
   * run with no database and no secrets. If these were read at import, the
   * production image build would need all three, and every deploy would depend
   * on the database being reachable from the builder.
   */
  it("reads the environment on every call, not once at import", () => {
    process.env.DATABASE_URL = "postgres://first.invalid/db"
    expect(requireDatabaseUrl()).toBe("postgres://first.invalid/db")

    process.env.DATABASE_URL = "postgres://second.invalid/db"
    expect(requireDatabaseUrl()).toBe("postgres://second.invalid/db")
  })

  /**
   * The same for every accessor, because importing this module is what
   * `next build` does. If any accessor read its variable at import rather than
   * at call time, the deployment build would need that variable.
   */
  it("lets every getter be imported with nothing set at all", () => {
    for (const name of VARIABLES) {
      delete process.env[name]
    }

    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/)
    expect(() => requireEncryptionKey()).toThrow(/ASSISTANT_SECRET_KEY/)
    expect(() => requireAuthSecret()).toThrow(/BETTER_AUTH_SECRET/)
    expect(() => requireAuthUrl()).toThrow(/BETTER_AUTH_URL/)
    expect(() => requirePipecatApiKey()).toThrow(/PIPECAT_API_KEY/)
    expect(readCallSweepToken()).toBeNull()
  })

  /**
   * `.env.example` is the app's account of what it needs, and item 19 requires
   * it to be complete and to contain nothing else.
   *
   * **This was "exactly the globally guarded variables" and is now "required
   * accessors plus declared-optional", so the replacement invariant needs to
   * stay explicit.** `CALL_SWEEP_TOKEN` is required only at its route and its
   * accessor reports absence for the route to refuse. `ALLOW_LOOPBACK_SERVER_URL`
   * genuinely has no accessor guard and should not have one: absence means
   * "off", which is already closed.
   *
   * So the teeth move rather than come out. An optional variable has to earn
   * its place by being **absent-safe** — with it unset the application must
   * behave as the safe default — and that is asserted below rather than
   * asserted about. A new *required* variable still has to have an accessor and
   * fail closed at its owning surface, because it will not be in
   * `OPTIONAL_VARIABLES` and the set comparison will fail.
   */
  it("lists exactly the required and declared-optional variables in .env.example", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../../../.env.example", import.meta.url)),
      "utf8"
    )

    const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)]
      .map((match) => match[1] ?? "")
      .sort()

    expect(listed).toStrictEqual([...VARIABLES, ...OPTIONAL_VARIABLES].sort())
  })
})

/**
 * The obligation that comes with being optional.
 *
 * A variable listed in `.env.example` without a guard is only acceptable while
 * its absence is the safe outcome. `ALLOW_LOOPBACK_SERVER_URL` unset must mean
 * loopback is **refused** — a default-on dev exception is a production hole
 * waiting for someone not to set the variable, which is exactly what this flag
 * was introduced to close.
 */
describe("declared-optional variables are absent-safe", () => {
  const savedFlag = process.env.ALLOW_LOOPBACK_SERVER_URL

  afterEach(() => {
    if (savedFlag === undefined) {
      delete process.env.ALLOW_LOOPBACK_SERVER_URL
    } else {
      process.env.ALLOW_LOOPBACK_SERVER_URL = savedFlag
    }
  })

  it.each([
    ["unset", undefined],
    ["the empty string", ""],
  ])(
    "refuses loopback when ALLOW_LOOPBACK_SERVER_URL is %s",
    (_label, value) => {
      if (value === undefined) {
        delete process.env.ALLOW_LOOPBACK_SERVER_URL
      } else {
        process.env.ALLOW_LOOPBACK_SERVER_URL = value
      }

      expect(
        validateServerUrl("http://localhost:3000/hook"),
        "loopback was accepted with the flag unset — the dev exception is on by default"
      ).not.toBeNull()
    }
  )

  it('accepts loopback only when it is exactly "true"', () => {
    process.env.ALLOW_LOOPBACK_SERVER_URL = "true"

    expect(validateServerUrl("http://localhost:3000/hook")).toBeNull()
  })

  /** Every optional variable is covered above; this fails if one is added. */
  it("has an absent-safe assertion for every declared-optional variable", () => {
    expect([...OPTIONAL_VARIABLES]).toStrictEqual([
      "ALLOW_LOOPBACK_SERVER_URL",
      "PIPECAT_PRIVATE_API_KEY",
      "PIPECAT_ORGANIZATION_ID",
      "PIPECAT_SERVICE_ID",
      "PIPECAT_DEPLOYMENT_ID",
      "SANDBOX_AGENT_API_BASE",
    ])
  })
})

/**
 * The Sandbox provider binding, and why its absence is the safe outcome.
 *
 * `readSandboxProviderEnvironment()` returns null unless the whole binding is
 * present and well-formed, and `sandboxExecutionConfigured()` is that predicate.
 * So a deployment missing any one of these does not dispatch a call with a
 * partial binding — it reports Sandbox execution as unavailable and starts
 * nothing. Absence costs the feature; it never costs a session that has already
 * begun billing.
 *
 * The CONTROL below is load-bearing. Every case here asserts that something
 * becomes **false**, and false is also what a predicate that always returns
 * false produces — so without a case proving the value can be true with the
 * binding intact, the whole block would pass against a broken predicate.
 */
describe("the Sandbox provider binding is absent-safe", () => {
  // A complete, well-formed synthetic binding. The three ids must satisfy the
  // UUID shape the reader enforces, and the two keys must differ — the same
  // value in both means one was pasted into the wrong variable.
  const BINDING = {
    PIPECAT_API_KEY: "synthetic-public-key",
    PIPECAT_PRIVATE_API_KEY: "synthetic-private-key",
    PIPECAT_ORGANIZATION_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    PIPECAT_SERVICE_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    PIPECAT_DEPLOYMENT_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
  } as const
  const TOUCHED = [
    ...Object.keys(BINDING),
    "SANDBOX_AGENT_API_BASE",
    "BETTER_AUTH_URL",
  ]
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const name of TOUCHED) saved.set(name, process.env[name])
    for (const [name, value] of Object.entries(BINDING))
      process.env[name] = value
    process.env.BETTER_AUTH_URL = "https://workspace.example.test"
    delete process.env.SANDBOX_AGENT_API_BASE
  })
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    saved.clear()
  })

  /**
   * Do not delete this for looking redundant among eight `false` assertions.
   *
   * It is the only case here that expects `true`, and that is the point: the
   * other eight would all pass against a `sandboxExecutionConfigured()` that
   * always returned `false`. Without this, the block would be decorative and
   * would stay decorative until someone shipped a reader that never reports a
   * configured provider. Verified by mutation — forcing the predicate to
   * `false` fails this test and no other.
   */
  it("CONTROL: reports execution configured while the whole binding is present", () => {
    expect(
      sandboxExecutionConfigured(),
      "the control failed, so every absence assertion below is vacuous"
    ).toBe(true)
  })

  it.each(
    [
      "PIPECAT_PRIVATE_API_KEY",
      "PIPECAT_ORGANIZATION_ID",
      "PIPECAT_SERVICE_ID",
      "PIPECAT_DEPLOYMENT_ID",
    ].flatMap((name) => [
      [name, "unset", undefined] as const,
      [name, "the empty string", ""] as const,
    ])
  )(
    "reports execution unavailable when %s is %s",
    (name, _label, value) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value

      expect(
        sandboxExecutionConfigured(),
        `${name} absent still reported a dispatchable provider`
      ).toBe(false)
    }
  )

  it.each([
    ["unset", undefined],
    ["the empty string", ""],
  ])(
    "falls back to the workspace origin when SANDBOX_AGENT_API_BASE is %s",
    (_label, value) => {
      if (value === undefined) delete process.env.SANDBOX_AGENT_API_BASE
      else process.env.SANDBOX_AGENT_API_BASE = value

      expect(resolveSandboxAgentApiBase()).toBe(requireAuthUrl())
    }
  )

  it("prefers the override when it is set, so the fallback is not the only path", () => {
    process.env.SANDBOX_AGENT_API_BASE = "https://tunnel.example.test"

    expect(resolveSandboxAgentApiBase()).toBe("https://tunnel.example.test")
  })
})
