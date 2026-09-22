import { randomBytes, randomUUID } from "node:crypto"

import { eq, sql } from "drizzle-orm"
import { afterAll, describe, expect, it, vi } from "vitest"

import { GET as configRoute } from "@/app/v1/agent/calls/[id]/config/route"
import { POST as registerRoute } from "@/app/v1/agent/calls/[id]/register/route"
import { GET as controlRoute } from "@/app/v1/agent/calls/[id]/control/route"
import { createAssistant } from "@/data/assistants"
import { getWorkspaceCallForAccount } from "@/data/calls"
import { closeDb, getDb } from "@/db/client"
import * as databaseClient from "@/db/client"
import {
  calls,
  sandboxAttempts,
  sandboxSessions,
  sandboxSlots,
} from "@/db/schema"
import { hashCredential, mintAgentToken } from "@/lib/credentials"
import { decryptSecret } from "@/lib/crypto"
import {
  getSandboxAttemptForAccount,
  hashSandboxControllerProof,
  prepareSandboxAttempt,
} from "@/sandbox/admission"
import { createSandboxLifecycle, sandboxLifecycle } from "@/sandbox/lifecycle"
import { createPipecatSandboxTransport } from "@/sandbox/pipecat-transport"
import { sandboxResourcesReleased } from "@/sandbox/browser-contract"
import {
  SANDBOX_PROTOCOL,
  type SandboxJoin,
  type SandboxTransport,
} from "@/sandbox/protocol"

import { signUpNewAccount } from "./helpers/auth.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

vi.mock("@/lib/credentials", async (original) => {
  const actual = await original<typeof import("@/lib/credentials")>()
  return { ...actual, mintAgentToken: vi.fn(actual.mintAgentToken) }
})
const provider = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock("@/control/pipecat", async (original) => ({
  ...(await original<typeof import("@/control/pipecat")>()),
  startPipecatSession: provider.start,
  stopPipecatSession: provider.stop,
}))

const binding = {
  organizationId: "synthetic-org",
  serviceId: "synthetic-service",
  deploymentId: "synthetic-deployment",
  agentName: "synthetic-agent",
}
const apiBase = "http://localhost:3000"
const describeDatabase = describe.skipIf(!isDatabaseConfigured())
afterAll(closeDb)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const account = await signUpNewAccount()
  const assistant = await createAssistant(account.accountId, {
    name: `Offline ${randomUUID()}`,
    voice: "marin",
    accentStyle: "Neutral.",
    instructions: "Use synthetic data only.",
    backendInstructions: "Answer briefly.",
    backendModel: "gpt-5.6-luna",
    waitingBehavior: "Acknowledge once.",
    tools: [],
  })
  let at = new Date()
  const initial = at.getTime()
  const prepared = await prepareSandboxAttempt({
    accountId: account.accountId,
    userId: account.userId,
    controllerProofHash: hashSandboxControllerProof(
      randomBytes(32).toString("base64url")
    )!,
    request: {
      clientAttemptId: randomUUID(),
      assistantId: assistant.id,
      baseRevision: 1,
      source: "saved",
    },
    now: at,
  })
  if (prepared.kind !== "created")
    throw new Error(`Prepare failed: ${prepared.kind}`)
  const [attempt] = await getDb()
    .select()
    .from(sandboxAttempts)
    .where(eq(sandboxAttempts.id, prepared.attempt.attemptId))
  const browser = {
    accountId: account.accountId,
    userId: account.userId,
    attemptId: attempt!.id,
    controllerProofHash: attempt!.controllerProofHash,
  }
  const owner = {
    sessionId: `session-${randomUUID()}`,
    bootId: `boot-${randomUUID()}`,
  }
  const join: SandboxJoin = {
    sessionId: owner.sessionId,
    dailyRoom: "https://synthetic.daily.co/test",
    dailyToken: `synthetic-join-${randomUUID()}`,
    expiresAt: new Date(initial + 900_000).toISOString(),
  }
  const transport = {
    start: vi
      .fn<SandboxTransport["start"]>()
      .mockResolvedValue({ kind: "started", join }),
    read: vi.fn<SandboxTransport["read"]>().mockResolvedValue({
      kind: "session",
      sessionId: owner.sessionId,
      binding,
      state: "running",
    }),
    stop: vi.fn<SandboxTransport["stop"]>().mockResolvedValue(undefined),
  }
  const lifecycle = createSandboxLifecycle({
    transport,
    binding,
    apiBase,
    now: () => at,
  })
  const agent = () => ({
    callId: attempt!.callId,
    token: transport.start.mock.calls[0]![0].agentToken,
    owner,
  })
  const rows = async () => {
    const [current] = await getDb()
      .select()
      .from(sandboxAttempts)
      .where(eq(sandboxAttempts.id, browser.attemptId))
    const [call] = await getDb()
      .select()
      .from(calls)
      .where(eq(calls.id, attempt!.callId))
    const slots = await getDb()
      .select()
      .from(sandboxSlots)
      .where(eq(sandboxSlots.attemptId, browser.attemptId))
    const sessions = await getDb()
      .select()
      .from(sandboxSessions)
      .where(eq(sandboxSessions.attemptId, browser.attemptId))
    return { attempt: current!, call: call!, slots, sessions }
  }
  const activate = async () => {
    await lifecycle.dispatch(browser)
    expect(await lifecycle.register(agent())).toEqual({ kind: "ok" })
    expect(await lifecycle.claim(agent(), apiBase)).toMatchObject({
      kind: "ok",
    })
    expect(await lifecycle.markReady(agent())).toEqual({ kind: "ok" })
  }
  return {
    lifecycle,
    transport,
    browser,
    owner,
    join,
    agent,
    rows,
    activate,
    initial,
    at: (elapsed: number) => {
      at = new Date(initial + elapsed)
    },
  }
}

describeDatabase(
  "offline Sandbox lifecycle (no provider capability claim)",
  () => {
    it.each(["commit", "rollback"])(
      "keeps delayed start identity B in cleanup and capacity after terminal registered A and dispatch timeout (%s)",
      async (durability) => {
        const f = await fixture()
        const sessionA = "11111111-1111-4111-8111-111111111111"
        const sessionB = "55555555-5555-4555-8555-555555555555"
        const providerBinding = {
          organizationId: "22222222-2222-4222-8222-222222222222",
          serviceId: "33333333-3333-4333-8333-333333333333",
          deploymentId: "44444444-4444-4444-8444-444444444444",
          agentName: "synthetic-agent",
        }
        const response = deferred<Response>()
        const postEntered = deferred<void>()
        const retentionEntered = deferred<void>()
        const retentionGate = deferred<void>()
        const retentionCommitted = deferred<void>()
        let gateNextTransaction = false
        let terminalB = false
        let agentToken = ""
        let at = new Date(f.initial)
        let requestSignal: AbortSignal | null = null
        const db = getDb()
        const transact = db.transaction.bind(db)
        // Delay only this exact transaction BEFORE BEGIN/the attempt row lock.
        // Every query, commit, registration and reconciliation uses real PG.
        const transaction: typeof db.transaction = async (callback, config) => {
          if (!gateNextTransaction) return transact(callback, config)
          gateNextTransaction = false
          retentionEntered.resolve()
          await retentionGate.promise
          try {
            return await transact(async (tx) => {
              const result = await callback(tx)
              if (durability === "rollback") {
                // A real PG error rolls back B and every write in its retention
                // transaction, after A has independently been confirmed stopped.
                await tx.execute(sql`select 1 / 0`)
              }
              return result
            }, config)
          } finally {
            retentionCommitted.resolve()
          }
        }
        const dbSpy = vi.spyOn(databaseClient, "getDb").mockReturnValue(
          new Proxy(db, {
            get(target, property, receiver) {
              return property === "transaction"
                ? transaction
                : Reflect.get(target, property, receiver)
            },
          })
        )
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async (url, request) => {
            if (request?.method === "POST") {
              agentToken = JSON.parse(String(request.body)).body.agentToken
              requestSignal = request.signal ?? null
              postEntered.resolve()
              const result = await response.promise
              gateNextTransaction = true
              return result
            }
            const sessionId = String(url).split("/").at(-1)
            if (request?.method === "DELETE")
              return Response.json({
                session_id: sessionId,
                status: "terminated",
              })
            const terminal = sessionId === sessionA || terminalB
            return Response.json({
              sessionId,
              organizationId: providerBinding.organizationId,
              serviceId: providerBinding.serviceId,
              deploymentId: providerBinding.deploymentId,
              createdAt: new Date(f.initial).toISOString(),
              endedAt: terminal ? at.toISOString() : null,
              completionStatus: terminal ? "completed" : null,
            })
          })
        const transport = createPipecatSandboxTransport({
          publicApiKey: "synthetic-public",
          privateApiKey: "synthetic-private",
          binding: providerBinding,
          fetchImpl: fetch,
          now: () => at,
        })
        const lifecycle = createSandboxLifecycle({
          transport,
          binding: providerBinding,
          apiBase: "https://platform.example.test",
          now: () => at,
        })
        let dispatchSettled = false
        const dispatch = lifecycle.dispatch(f.browser).then((result) => {
          dispatchSettled = true
          return result
        })
        try {
          await postEntered.promise
          const callId = (await f.rows()).call.id
          expect(
            await lifecycle.register({
              callId,
              token: agentToken,
              owner: { sessionId: sessionA, bootId: "boot-a" },
            })
          ).toEqual({ kind: "ok" })
          await lifecycle.stop(f.browser)
          const beforeB = await f.rows()
          expect(beforeB.sessions).toMatchObject([
            { sessionId: sessionA, resourceState: "confirmed_stopped" },
          ])
          expect(beforeB.attempt.dispatchSettledAt).toBeNull()
          expect(beforeB.slots).toHaveLength(1)

          response.resolve(
            Response.json({
              sessionId: sessionB,
              dailyRoom: "https://synthetic.daily.co/test",
              dailyToken: "synthetic-token",
            })
          )
          await retentionEntered.promise
          // The real 15-second dispatch timer fires while B has not acquired a
          // transaction/row lock. No database writes or outcomes are mocked.
          await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true), {
            timeout: 20_000,
            interval: 20,
          })
          await new Promise((resolve) => setTimeout(resolve, 100))
          at = new Date(f.initial + 15_000)
          await lifecycle.reconcile(f.browser.attemptId)
          const timedOut = await f.rows()
          expect
            .soft(dispatchSettled, "timeout cannot detach identity persistence")
            .toBe(false)
          expect.soft(timedOut.attempt.dispatchSettledAt).toBeNull()
          expect
            .soft(
              timedOut.slots,
              "A alone cannot release capacity while B retention is pending"
            )
            .toHaveLength(1)

          retentionGate.resolve()
          await retentionCommitted.promise
          await dispatch
          const committed = await f.rows()
          if (durability === "rollback") {
            expect(committed.sessions.map((row) => row.sessionId)).toEqual([
              sessionA,
            ])
            expect(committed.attempt.dispatchSettledAt).toBeNull()
            expect(committed.attempt.resourceState).not.toBe(
              "confirmed_stopped"
            )
            expect(committed.attempt.joinCiphertext).toBeNull()
            expect(committed.slots).toMatchObject([
              { accountId: f.browser.accountId, userId: f.browser.userId },
            ])
            expect(await lifecycle.join(f.browser)).not.toHaveProperty("join")
            at = new Date(f.initial + 40_000)
            expect(await lifecycle.sweep()).toBeGreaterThan(0)
            expect((await f.rows()).attempt.dispatchSettledAt).toBeNull()
            expect((await f.rows()).slots).toHaveLength(1)
            expect((await f.rows()).call.state).not.toBe("ended")
            expect(
              fetch.mock.calls.filter(
                ([, request]) => request?.method === "POST"
              )
            ).toHaveLength(1)
            return
          }
          expect
            .soft(committed.sessions.map((row) => row.sessionId).sort())
            .toEqual([sessionA, sessionB].sort())
          expect
            .soft(committed.attempt.resourceState)
            .not.toBe("confirmed_stopped")
          expect
            .soft(
              committed.slots,
              "unresolved B must remain in account slot accounting"
            )
            .toHaveLength(1)
          expect
            .soft(
              committed.sessions.find((row) => row.sessionId === sessionB)
                ?.confirmedStoppedAt
            )
            .toBeNull()

          at = new Date(f.initial + 20_000)
          const callsBeforeSweep = fetch.mock.calls.length
          await lifecycle.sweep()
          expect
            .soft(
              fetch.mock.calls
                .slice(callsBeforeSweep)
                .some(
                  ([url, request]) =>
                    String(url).endsWith(sessionB) && request?.method === "GET"
                ),
              "sweep must still discover unresolved B"
            )
            .toBe(true)
          expect.soft((await f.rows()).slots).toHaveLength(1)
          terminalB = true
          at = new Date(f.initial + 40_000)
          await lifecycle.sweep()
          const stopped = await f.rows()
          expect(
            stopped.sessions.every(
              (row) => row.resourceState === "confirmed_stopped"
            )
          ).toBe(true)
          expect(stopped.attempt.resourceState).toBe("confirmed_stopped")
          expect(stopped.slots).toHaveLength(0)
          expect(
            fetch.mock.calls.filter(([, request]) => request?.method === "POST")
          ).toHaveLength(1)
        } finally {
          retentionGate.resolve()
          response.resolve(Response.json({ sessionId: sessionB }))
          try {
            await dispatch
          } finally {
            dbSpy.mockRestore()
          }
        }
      }
    )

    it.each(["malformed_media", "unverified_media", "verifier_failure"])(
      "retains the real adapter's observed identity on %s and requires independent terminal GET to release",
      async (failure) => {
        const f = await fixture()
        const sessionId = "11111111-1111-4111-8111-111111111111"
        const providerBinding = {
          organizationId: "22222222-2222-4222-8222-222222222222",
          serviceId: "33333333-3333-4333-8333-333333333333",
          deploymentId: "44444444-4444-4444-8444-444444444444",
          agentName: "synthetic-agent",
        }
        let at = new Date(f.initial)
        let readStatus = 200
        let terminal = false
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async (_url, request) => {
            if (request?.method === "POST")
              return Response.json({
                sessionId,
                dailyRoom:
                  failure === "malformed_media"
                    ? null
                    : "https://synthetic.daily.co/test",
                dailyToken: "CANARY_BROWSER_TOKEN",
              })
            // These DB queries use a separate transaction, proving retention
            // committed before verification or exact-resource cleanup began.
            expect(
              (await f.rows()).sessions.map((row) => row.sessionId)
            ).toEqual([sessionId])
            if (request?.method === "DELETE")
              return Response.json({
                session_id: sessionId,
                status: "terminated",
              })
            expect(request?.method).toBe("GET")
            if (readStatus === 404) return Response.json({}, { status: 404 })
            return Response.json({
              sessionId,
              organizationId: providerBinding.organizationId,
              serviceId: providerBinding.serviceId,
              deploymentId: providerBinding.deploymentId,
              createdAt: new Date(f.initial).toISOString(),
              endedAt: terminal ? at.toISOString() : null,
              completionStatus: terminal ? "completed" : null,
            })
          })
        let retainedAtVerification: string[] = []
        const verify = vi.fn(async () => {
          retainedAtVerification = (await f.rows()).sessions.map(
            (row) => row.sessionId
          )
          throw new Error("CANARY_VERIFIER_FAILURE")
        })
        const transport = createPipecatSandboxTransport({
          publicApiKey: "synthetic-public",
          privateApiKey: "synthetic-private",
          binding: providerBinding,
          fetchImpl: fetch,
          now: () => at,
          ...(failure === "verifier_failure"
            ? { verifyBrowserMedia: verify }
            : {}),
        })
        const lifecycle = createSandboxLifecycle({
          transport,
          binding: providerBinding,
          apiBase: "https://platform.example.test",
          now: () => at,
        })
        await expect(lifecycle.dispatch(f.browser)).resolves.toEqual({
          kind: "processed",
        })
        const unknown = await f.rows()
        expect(unknown.attempt.dispatchSettledAt).not.toBeNull()
        expect(unknown.attempt.stopReason).toBe("start_unknown")
        expect(unknown.attempt.joinCiphertext).toBeNull()
        expect(unknown.sessions).toHaveLength(1)
        expect(unknown.sessions[0]!.sessionId).toBe(sessionId)
        expect(unknown.sessions[0]!.stopAttempts).toBe(1)
        expect(unknown.attempt.resourceState).not.toBe("confirmed_stopped")
        expect(unknown.slots).toHaveLength(1)
        expect(fetch.mock.calls.map(([, request]) => request!.method)).toEqual([
          "POST",
          "GET",
          "GET",
          "DELETE",
        ])
        if (failure === "verifier_failure") {
          expect(verify).toHaveBeenCalledTimes(1)
          expect(retainedAtVerification).toEqual([sessionId])
        }
        expect(await lifecycle.join(f.browser)).not.toHaveProperty("join")

        readStatus = 404
        at = new Date(f.initial + 5_000)
        await lifecycle.reconcile(f.browser.attemptId)
        expect((await f.rows()).slots).toHaveLength(1)
        expect((await f.rows()).sessions[0]!.confirmedStoppedAt).toBeNull()
        expect(
          fetch.mock.calls.filter(([, request]) => request!.method === "DELETE")
        ).toHaveLength(1)

        readStatus = 200
        terminal = true
        at = new Date(f.initial + 20_000)
        await lifecycle.reconcile(f.browser.attemptId)
        const stopped = await f.rows()
        expect(stopped.slots).toHaveLength(0)
        expect(stopped.attempt.resourceState).toBe("confirmed_stopped")
        expect(stopped.sessions[0]!.confirmedStoppedAt).toEqual(at)
        expect(stopped.call.state).toBe("failed")
        expect(stopped.call.state).not.toBe("ended")
        expect(
          fetch.mock.calls.filter(([, request]) => request!.method === "POST")
        ).toHaveLength(1)
        expect(
          fetch.mock.calls.filter(([, request]) => request!.method === "DELETE")
        ).toHaveLength(1)
      }
    )

    it("does not let a contradictory no-start result erase a durably retained session", async () => {
      const f = await fixture()
      let retainedBeforeRejection: string[] = []
      f.transport.start.mockImplementation(async (_input, _signal, context) => {
        await context.retainSession(f.owner.sessionId)
        retainedBeforeRejection = (await f.rows()).sessions.map(
          (row) => row.sessionId
        )
        return { kind: "definite_no_start" }
      })
      await f.lifecycle.dispatch(f.browser)
      expect(retainedBeforeRejection).toEqual([f.owner.sessionId])
      expect((await f.rows()).slots).toHaveLength(1)
      expect((await f.rows()).attempt.resourceState).not.toBe(
        "confirmed_stopped"
      )
      expect((await f.rows()).attempt.stopReason).toBe("start_unknown")
      expect(f.transport.stop).toHaveBeenCalledTimes(1)
    })

    it("projects safe readiness and server time without treating call completion as resource release", async () => {
      const f = await fixture()
      const before = await getSandboxAttemptForAccount({
        ...f.browser,
        now: new Date(f.initial),
      })
      expect(before).toMatchObject({
        readyAt: null,
        serverTime: new Date(f.initial).toISOString(),
        execution: "disabled",
      })
      await f.activate()
      const at = new Date(f.initial + 5_000)
      const after = await getSandboxAttemptForAccount({ ...f.browser, now: at })
      expect(after).toMatchObject({
        readyAt: new Date(f.initial).toISOString(),
        serverTime: at.toISOString(),
        execution: "disabled",
      })
      expect(JSON.stringify(after)).not.toMatch(
        /controller|credential|token|daily|room|secret|sessionId|bootId|organizationId|serviceId|deploymentId/i
      )
      expect(sandboxResourcesReleased(after!)).toBe(false)
    })

    it("retains the exact resource and stops when join encryption is unavailable", async () => {
      const f = await fixture()
      vi.stubEnv("ASSISTANT_SECRET_KEY", "")
      try {
        await expect(f.lifecycle.dispatch(f.browser)).resolves.toEqual({
          kind: "processed",
        })
        const rows = await f.rows()
        expect(rows.attempt.stopReason).toBe("join_unavailable")
        expect(rows.attempt.joinCiphertext).toBeNull()
        expect(rows.sessions.map((session) => session.sessionId)).toEqual([
          f.owner.sessionId,
        ])
        expect(f.transport.stop).toHaveBeenCalledWith(
          f.owner.sessionId,
          expect.any(AbortSignal)
        )
        expect(rows.slots).toHaveLength(1)
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it("commits one dispatch and token mint under concurrent starts and retries", async () => {
      const f = await fixture()
      const entered = deferred<void>()
      const reply = deferred<Awaited<ReturnType<SandboxTransport["start"]>>>()
      f.transport.start.mockImplementation(() => {
        entered.resolve()
        return reply.promise
      })
      vi.mocked(mintAgentToken).mockClear()
      const first = f.lifecycle.dispatch(f.browser)
      await entered.promise
      const competing = await Promise.all(
        Array.from({ length: 5 }, () => f.lifecycle.dispatch(f.browser))
      )
      expect(competing.every((result) => result.kind === "unchanged")).toBe(
        true
      )
      const before = await f.rows()
      expect(before.call.agentTokenHash).toBe(hashCredential(f.agent().token))
      reply.resolve({ kind: "started", join: f.join })
      await first
      await f.lifecycle.dispatch(f.browser)
      expect(f.transport.start).toHaveBeenCalledTimes(1)
      expect(mintAgentToken).toHaveBeenCalledTimes(1)
      expect((await f.rows()).call.agentTokenHash).toBe(
        before.call.agentTokenHash
      )
      expect(Object.keys(f.transport.start.mock.calls[0]![0]).sort()).toEqual([
        "agentToken",
        "apiBase",
        "callId",
      ])
    })

    it("lets registration race the start response but never releases a stopped slot mid-dispatch", async () => {
      const f = await fixture()
      const entered = deferred<void>()
      const reply = deferred<Awaited<ReturnType<SandboxTransport["start"]>>>()
      f.transport.start.mockImplementation(() => {
        entered.resolve()
        return reply.promise
      })
      const start = f.lifecycle.dispatch(f.browser)
      await entered.promise
      expect(await f.lifecycle.register(f.agent())).toEqual({ kind: "ok" })
      f.transport.read.mockResolvedValue({
        kind: "session",
        sessionId: f.owner.sessionId,
        binding,
        state: "stopped",
      })
      await f.lifecycle.stop(f.browser)
      expect((await f.rows()).slots).toHaveLength(1)
      reply.resolve({ kind: "started", join: f.join })
      await start
      const rows = await f.rows()
      expect(rows.slots).toHaveLength(0)
      expect(rows.attempt.joinCiphertext).toBeNull()
      expect(rows.call.state).toBe("failed")
      expect(await f.lifecycle.join(f.browser)).toEqual({ kind: "unavailable" })
    })

    it("cleans both exact sessions when registration and the start result disagree", async () => {
      const f = await fixture()
      const entered = deferred<void>()
      const reply = deferred<Awaited<ReturnType<SandboxTransport["start"]>>>()
      f.transport.start.mockImplementation(() => {
        entered.resolve()
        return reply.promise
      })
      const start = f.lifecycle.dispatch(f.browser)
      await entered.promise
      await f.lifecycle.register(f.agent())
      const other = "different-provider-session"
      f.transport.read.mockImplementation(async (sessionId) => ({
        kind: "session",
        sessionId,
        binding,
        state: "running",
      }))
      reply.resolve({ kind: "started", join: { ...f.join, sessionId: other } })
      await start
      expect((await f.rows()).attempt).toMatchObject({
        stopReason: "identity_conflict",
        joinCiphertext: null,
      })
      expect(f.transport.stop.mock.calls.map(([id]) => id).sort()).toEqual(
        [other, f.owner.sessionId].sort()
      )
      expect((await f.rows()).slots).toHaveLength(1)
    })

    it("binds config to registration and returns the plaintext Practice secret only once", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      expect(await f.lifecycle.claim(f.agent(), apiBase)).toEqual({
        kind: "not_found",
      })
      expect(
        await f.lifecycle.register({ ...f.agent(), token: "wrong-token" })
      ).toEqual({ kind: "not_found" })
      await f.lifecycle.register(f.agent())
      expect(
        await f.lifecycle.claim(
          { ...f.agent(), owner: { ...f.owner, bootId: "other-boot" } },
          apiBase
        )
      ).toEqual({ kind: "not_found" })
      const claims = await Promise.all([
        f.lifecycle.claim(f.agent(), apiBase),
        f.lifecycle.claim(f.agent(), apiBase),
      ])
      expect(claims.map((claim) => claim.kind).sort()).toEqual([
        "already_claimed",
        "ok",
      ])
      const claimed = claims.find((claim) => claim.kind === "ok")!
      if (claimed.kind !== "ok") throw new Error("Missing config")
      const plaintext = claimed.config.config.serverSecret
      expect(claimed.config).toMatchObject({
        protocol: SANDBOX_PROTOCOL,
        owner: f.owner,
        control: {
          controlLossTimeoutMs: 30_000,
          gracefulStopMs: 10_000,
          reportingGraceMs: 60_000,
        },
      })
      const rows = await f.rows()
      expect(decryptSecret(rows.call.practiceSecretCiphertext!)).toBe(plaintext)
      expect(JSON.stringify(rows)).not.toContain(plaintext)
      expect(rows.call.configClaimedAt).not.toBeNull()
    })

    it("encrypts join data and redacts credentials from status and history", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      expect(await f.lifecycle.join(f.browser)).toEqual({
        kind: "ok",
        join: f.join,
      })
      expect(
        await f.lifecycle.join({ ...f.browser, controllerProofHash: "wrong" })
      ).toEqual({ kind: "invalid_controller" })
      expect(
        await f.lifecycle.join({ ...f.browser, accountId: randomUUID() })
      ).toEqual({ kind: "not_found" })
      const rows = await f.rows()
      expect(JSON.parse(decryptSecret(rows.attempt.joinCiphertext!))).toEqual({
        attemptId: f.browser.attemptId,
        callId: f.agent().callId,
        join: f.join,
      })
      expect(rows.call.dailyRoom).toBeNull()
      const status = await getSandboxAttemptForAccount(f.browser)
      const history = await getWorkspaceCallForAccount(
        f.browser.accountId,
        f.agent().callId
      )
      for (const value of [rows, status, history]) {
        expect(JSON.stringify(value)).not.toContain(f.join.dailyToken)
        expect(JSON.stringify(value)).not.toContain(f.join.dailyRoom)
        expect(JSON.stringify(value)).not.toContain(f.agent().token)
      }
    })

    it.each(["lost", "malformed"])(
      "retains unknown slots after a %s start response and elapsed deadlines",
      async (failure) => {
        const f = await fixture()
        if (failure === "lost")
          f.transport.start.mockRejectedValue(
            new Error("lost synthetic response")
          )
        else
          f.transport.start.mockResolvedValue({
            kind: "started",
            join: { ...f.join, dailyRoom: "https://untrusted.invalid/room" },
          })
        await f.lifecycle.dispatch(f.browser)
        expect((await f.rows()).attempt.stopReason).toBe("start_unknown")
        expect(await f.lifecycle.join(f.browser)).toEqual({
          kind: "unavailable",
        })
        f.at(1_000_000)
        await f.lifecycle.reconcile(f.browser.attemptId)
        expect((await f.rows()).slots).toHaveLength(1)
        expect((await f.rows()).call.state).toBe("failed")
        await f.lifecycle.dispatch(f.browser)
        expect(f.transport.start).toHaveBeenCalledTimes(1)
      }
    )

    it("releases a definitive no-start rejection without cleanup calls", async () => {
      const f = await fixture()
      f.transport.start.mockResolvedValue({ kind: "definite_no_start" })
      await f.lifecycle.dispatch(f.browser)
      expect((await f.rows()).attempt.resourceState).toBe("confirmed_stopped")
      expect((await f.rows()).slots).toHaveLength(0)
      expect(f.transport.read).not.toHaveBeenCalled()
      expect(f.transport.stop).not.toHaveBeenCalled()
    })

    it("does not treat 404 or successful DELETE as stop proof; exact terminal evidence releases the slot", async () => {
      const f = await fixture()
      await f.activate()
      f.transport.read.mockResolvedValueOnce({ kind: "not_found" })
      await f.lifecycle.stop(f.browser)
      expect(f.transport.stop).not.toHaveBeenCalled()
      expect((await f.rows()).slots).toHaveLength(1)
      f.at(15_000)
      await Promise.all([
        f.lifecycle.reconcile(f.browser.attemptId),
        f.lifecycle.reconcile(f.browser.attemptId),
      ])
      expect(f.transport.stop).toHaveBeenCalledTimes(1)
      expect((await f.rows()).slots).toHaveLength(1)
      f.transport.read.mockResolvedValue({
        kind: "session",
        sessionId: f.owner.sessionId,
        binding,
        state: "stopped",
      })
      f.at(20_000)
      await f.lifecycle.reconcile(f.browser.attemptId)
      expect((await f.rows()).slots).toHaveLength(0)
      expect((await f.rows()).call.state).toBe("incomplete")
      expect((await f.rows()).attempt.resourceState).toBe("confirmed_stopped")
    })

    it.each([
      "organizationId",
      "serviceId",
      "deploymentId",
      "agentName",
      "sessionId",
      "forbidden",
    ])("blocks cleanup for mismatched %s evidence", async (field) => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      f.transport.read.mockResolvedValue(
        field === "forbidden"
          ? { kind: "forbidden" }
          : {
              kind: "session",
              sessionId:
                field === "sessionId" ? "foreign-session" : f.owner.sessionId,
              binding: {
                ...binding,
                ...(field !== "sessionId" ? { [field]: "foreign" } : {}),
              },
              state: "stopped",
            }
      )
      await f.lifecycle.stop(f.browser)
      const rows = await f.rows()
      expect(rows.sessions[0]?.reconciliationBlocked).toBe(true)
      expect(rows.slots).toHaveLength(1)
      expect(f.transport.stop).not.toHaveBeenCalled()
    })

    it("counts lost DELETE outcomes and caps mutation retries at three", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      f.transport.stop.mockRejectedValue(new Error("lost DELETE response"))
      await f.lifecycle.stop(f.browser)
      for (const time of [5_000, 20_000, 35_000, 50_000]) {
        f.at(time)
        await f.lifecycle.reconcile(f.browser.attemptId)
      }
      expect(f.transport.stop).toHaveBeenCalledTimes(3)
      expect((await f.rows()).sessions[0]?.stopAttempts).toBe(3)
      expect((await f.rows()).slots).toHaveLength(1)
    })

    it("derives retry spacing from the locked counter when another reconciler advances a later target", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      await getDb()
        .insert(sandboxSessions)
        .values({
          attemptId: f.browser.attemptId,
          sessionId: "second-exact-session",
          nextReconcileAt: new Date(f.initial),
        })
      await getDb()
        .update(sandboxAttempts)
        .set({
          stopRequestedAt: new Date(f.initial),
          stopReason: "identity_conflict",
          state: "stopping",
        })
        .where(eq(sandboxAttempts.id, f.browser.attemptId))
      const entered = deferred<void>()
      const release = deferred<void>()
      let paused: string | null = null
      f.transport.read.mockImplementation(async (sessionId) => {
        if (paused === null) {
          paused = sessionId
          entered.resolve()
          await release.promise
        }
        return { kind: "session", sessionId, binding, state: "running" }
      })
      const first = f.lifecycle.reconcile(f.browser.attemptId)
      await entered.promise
      await f.lifecycle.reconcile(f.browser.attemptId)
      f.at(6_000)
      release.resolve()
      await first
      const later = (await f.rows()).sessions.find(
        (session) => session.sessionId !== paused
      )!
      expect(later.stopAttempts).toBe(2)
      expect(later.nextReconcileAt.getTime()).toBe(f.initial + 21_000)
    })

    it("enforces stop grace and reporting grace without inventing a clean ending", async () => {
      const f = await fixture()
      await f.activate()
      await f.lifecycle.stop(f.browser)
      expect(await f.lifecycle.control(f.agent())).toMatchObject({
        kind: "ok",
        control: { stopRequested: true, stopReason: "user_stopped" },
      })
      f.at(9_999)
      await f.lifecycle.reconcile(f.browser.attemptId)
      expect((await f.rows()).call.state).toBe("active")
      f.at(10_000)
      await f.lifecycle.reconcile(f.browser.attemptId)
      expect((await f.rows()).call.state).toBe("incomplete")
      f.at(69_999)
      expect(await f.lifecycle.control(f.agent())).toMatchObject({ kind: "ok" })
      f.at(70_000)
      expect(await f.lifecycle.control(f.agent())).toEqual({ kind: "expired" })
      expect((await f.rows()).slots).toHaveLength(1)
    })

    it("expires presence at 60s and refuses to revive it", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      f.at(59_999)
      expect(await f.lifecycle.join(f.browser)).toMatchObject({ kind: "ok" })
      f.at(60_000)
      expect(await f.lifecycle.presence(f.browser)).toEqual({ kind: "expired" })
      expect((await f.rows()).attempt.stopReason).toBe("presence_expired")
    })

    it("stops exactly at 120s startup even with healthy browser presence", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      for (const time of [50_000, 100_000, 119_999]) {
        f.at(time)
        expect(await f.lifecycle.presence(f.browser)).toMatchObject({
          kind: "ok",
        })
      }
      f.at(120_000)
      expect(await f.lifecycle.presence(f.browser)).toEqual({ kind: "expired" })
      expect((await f.rows()).attempt.stopReason).toBe("startup_deadline")
    })

    it("stops after 30s without control and a late poll cannot heal it", async () => {
      const f = await fixture()
      await f.activate()
      f.at(29_999)
      await f.lifecycle.reconcile(f.browser.attemptId)
      expect((await f.rows()).attempt.stopRequestedAt).toBeNull()
      f.at(30_000)
      expect(await f.lifecycle.control(f.agent())).toMatchObject({
        kind: "ok",
        control: { stopRequested: true, stopReason: "control_lost" },
      })
    })

    it("keeps the 600s execution deadline fixed across healthy control and presence", async () => {
      const f = await fixture()
      await f.activate()
      for (let time = 20_000; time < 600_000; time += 20_000) {
        f.at(time)
        expect(await f.lifecycle.control(f.agent())).toMatchObject({
          kind: "ok",
          control: { stopRequested: false },
        })
        expect(await f.lifecycle.presence(f.browser)).toMatchObject({
          kind: "ok",
        })
      }
      f.at(599_999)
      expect(await f.lifecycle.presence(f.browser)).toEqual({
        kind: "ok",
        presenceExpiresAt: new Date(f.initial + 600_000).toISOString(),
      })
      f.at(600_000)
      expect(await f.lifecycle.control(f.agent())).toMatchObject({
        kind: "ok",
        control: {
          stopRequested: true,
          stopReason: "execution_deadline",
          executionDeadline: new Date(f.initial + 600_000).toISOString(),
        },
      })
    })

    it("keeps the production singleton disabled with no tokens or providers", async () => {
      const f = await fixture()
      vi.mocked(mintAgentToken).mockClear()
      provider.start.mockClear()
      provider.stop.mockClear()
      for (const operation of [
        sandboxLifecycle.dispatch,
        sandboxLifecycle.join,
        sandboxLifecycle.presence,
      ])
        expect(await operation(f.browser)).toMatchObject({ kind: "disabled" })
      expect((await f.rows()).call.agentTokenHash).toBeNull()
      expect(mintAgentToken).not.toHaveBeenCalled()
      expect(provider.start).not.toHaveBeenCalled()
      expect(provider.stop).not.toHaveBeenCalled()
      expect(f.transport.start).not.toHaveBeenCalled()
    })

    it("records a stop at the 15s dispatch deadline and rejects a late successful join", async () => {
      const f = await fixture()
      const entered = deferred<void>()
      const reply = deferred<Awaited<ReturnType<SandboxTransport["start"]>>>()
      f.transport.start.mockImplementation(() => {
        entered.resolve()
        return reply.promise
      })
      const start = f.lifecycle.dispatch(f.browser)
      await entered.promise
      f.at(14_999)
      await f.lifecycle.reconcile(f.browser.attemptId)
      expect((await f.rows()).attempt.stopRequestedAt).toBeNull()
      f.at(15_000)
      await f.lifecycle.reconcile(f.browser.attemptId)
      expect((await f.rows()).attempt).toMatchObject({
        stopReason: "start_unknown",
        stopRequestedAt: new Date(f.initial + 15_000),
      })
      expect((await f.rows()).slots).toHaveLength(1)
      reply.resolve({ kind: "started", join: f.join })
      await start
      expect(await f.lifecycle.join(f.browser)).toEqual({ kind: "unavailable" })
      expect(f.transport.stop).toHaveBeenCalledWith(
        f.owner.sessionId,
        expect.any(AbortSignal)
      )
    })

    it("anchors a stale request to the original deadline without renewing reporting grace", async () => {
      const f = await fixture()
      await f.activate()
      f.at(120_000)
      expect(await f.lifecycle.control(f.agent())).toEqual({ kind: "expired" })
      const rows = await f.rows()
      expect(rows.attempt).toMatchObject({
        stopReason: "control_lost",
        stopRequestedAt: new Date(f.initial + 30_000),
        reportingUntil: new Date(f.initial + 100_000),
      })
      expect(rows.call.state).toBe("incomplete")
      expect(rows.slots).toHaveLength(1)
    })

    it("rejects encrypted join ciphertext copied from another attempt", async () => {
      const first = await fixture()
      const second = await fixture()
      await first.lifecycle.dispatch(first.browser)
      await second.lifecycle.dispatch(second.browser)
      await getDb()
        .update(sandboxAttempts)
        .set({ joinCiphertext: (await first.rows()).attempt.joinCiphertext })
        .where(eq(sandboxAttempts.id, second.browser.attemptId))
      // Keep the provider-session comparison equal so only the encrypted
      // attempt/call binding can reject this otherwise valid credential.
      await getDb()
        .update(calls)
        .set({ pipecatSessionId: first.owner.sessionId })
        .where(eq(calls.id, second.agent().callId))
      expect(await second.lifecycle.join(second.browser)).toEqual({
        kind: "unavailable",
      })
    })

    it("retains all authenticated A/B/C session references after conflict until each is terminal", async () => {
      const f = await fixture()
      await f.activate()
      const b = { sessionId: "conflicting-session-b", bootId: "boot-b" }
      const c = { sessionId: "conflicting-session-c", bootId: "boot-c" }
      for (const owner of [b, c]) {
        expect(await f.lifecycle.register({ ...f.agent(), owner })).toEqual({
          kind: "identity_conflict",
        })
      }
      expect(
        (await f.rows()).sessions.map((session) => session.sessionId).sort()
      ).toEqual([f.owner.sessionId, b.sessionId, c.sessionId].sort())
      f.transport.read.mockImplementation(async (sessionId) => ({
        kind: "session",
        sessionId,
        binding,
        state: sessionId === c.sessionId ? "running" : "stopped",
      }))
      await f.lifecycle.reconcile(f.browser.attemptId)
      const unresolved = await f.rows()
      expect(unresolved.slots).toHaveLength(1)
      expect(unresolved.attempt.resourceState).not.toBe("confirmed_stopped")
      expect(f.transport.stop).toHaveBeenCalledWith(
        c.sessionId,
        expect.any(AbortSignal)
      )
      expect(
        unresolved.sessions.filter(
          (session) => session.resourceState === "confirmed_stopped"
        )
      ).toHaveLength(2)
      f.at(5_000)
      f.transport.read.mockImplementation(async (sessionId) => ({
        kind: "session",
        sessionId,
        binding,
        state: "stopped",
      }))
      await f.lifecycle.reconcile(f.browser.attemptId)
      expect((await f.rows()).slots).toHaveLength(0)
      expect(
        (await f.rows()).sessions.every(
          (session) => session.resourceState === "confirmed_stopped"
        )
      ).toBe(true)
    })

    it.each([false, true])(
      "preserves overdue control and reporting deadlines when late Stop is first (terminal readback=%s)",
      async (terminal) => {
        const f = await fixture()
        await f.activate()
        f.transport.read.mockResolvedValue({
          kind: "session",
          sessionId: f.owner.sessionId,
          binding,
          state: terminal ? "stopped" : "running",
        })
        f.at(120_000)
        await f.lifecycle.stop(f.browser)
        const rows = await f.rows()
        expect(rows.attempt).toMatchObject({
          stopReason: "control_lost",
          stopRequestedAt: new Date(f.initial + 30_000),
          reportingUntil: new Date(f.initial + 100_000),
        })
        expect(rows.call).toMatchObject({
          state: "incomplete",
          stopRequestedAt: new Date(f.initial + 30_000),
        })
        expect(rows.slots).toHaveLength(terminal ? 0 : 1)
        expect(await f.lifecycle.control(f.agent())).toEqual({
          kind: "expired",
        })
      }
    )

    it("does not replace a registered boot with another boot on the same session", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      await f.lifecycle.register(f.agent())
      expect(await f.lifecycle.register(f.agent())).toEqual({ kind: "ok" })
      expect(
        await f.lifecycle.register({
          ...f.agent(),
          owner: { ...f.owner, bootId: "replacement-boot" },
        })
      ).toEqual({ kind: "identity_conflict" })
      expect((await f.rows()).attempt.runtimeBootId).toBe(f.owner.bootId)
      expect(await f.lifecycle.claim(f.agent(), apiBase)).toEqual({
        kind: "expired",
      })
    })
    it("requires explicit protocol and registration for the private routes; legacy config cannot claim Sandbox", async () => {
      const f = await fixture()
      await f.lifecycle.dispatch(f.browser)
      const context = { params: Promise.resolve({ id: f.agent().callId }) }
      const headers = {
        authorization: `Bearer ${f.agent().token}`,
        "x-duplexd-protocol": SANDBOX_PROTOCOL,
        "x-duplexd-session-id": f.owner.sessionId,
        "x-duplexd-boot-id": f.owner.bootId,
      }
      const request = (overrides: Record<string, string> = {}) =>
        new Request(apiBase, { headers: { ...headers, ...overrides } })
      const legacy = await configRoute(
        new Request(apiBase, {
          headers: { authorization: headers.authorization },
        }),
        context
      )
      expect(legacy.status).toBe(401)
      expect((await f.rows()).call.configClaimedAt).toBeNull()
      expect(
        (
          await configRoute(
            request({ "x-duplexd-protocol": "sandbox-v0" }),
            context
          )
        ).status
      ).toBe(426)
      expect((await configRoute(request(), context)).status).toBe(404)
      expect(
        (
          await registerRoute(
            new Request(apiBase, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(f.owner),
            }),
            context
          )
        ).status
      ).toBe(200)
      const config = await configRoute(request(), context)
      expect(config.status).toBe(200)
      expect(config.headers.get("cache-control")).toContain("no-store")
      expect(await config.json()).toMatchObject({
        protocol: SANDBOX_PROTOCOL,
        owner: f.owner,
        config: {
          assistantId: expect.any(String),
          serverSecret: expect.any(String),
        },
      })
      expect((await configRoute(request(), context)).status).toBe(409)
      expect(
        (
          await controlRoute(
            request({ "x-duplexd-boot-id": "wrong-boot" }),
            context
          )
        ).status
      ).toBe(404)
      const control = await controlRoute(request(), context)
      expect(control.status).toBe(200)
      expect(control.headers.get("cache-control")).toContain("no-store")
    })
  }
)
