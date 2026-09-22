import { randomBytes, randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { expect, vi } from "vitest"
import { createAssistant } from "@/data/assistants"
import { getDb } from "@/db/client"
import {
  calls,
  sandboxAttempts,
  sandboxSlots,
  sandboxEvidence,
} from "@/db/schema"
import {
  hashSandboxControllerProof,
  prepareSandboxAttempt,
} from "@/sandbox/admission"
import { createSandboxLifecycle } from "@/sandbox/lifecycle"
import { createSandboxEvidence } from "@/sandbox/evidence"
import type { SandboxTransport } from "@/sandbox/protocol"
import { signUpNewAccount } from "./auth.ts"

/** Synthetic injected transport; no provider or network request can run here. */
export async function sandboxFixture() {
  const account = await signUpNewAccount()
  const assistant = await createAssistant(account.accountId, {
    name: `Evidence ${randomUUID()}`,
    voice: "marin",
    accentStyle: "Neutral.",
    instructions: "Synthetic data only.",
    backendInstructions: "Answer briefly.",
    backendModel: "gpt-5.6-luna",
    waitingBehavior: "Acknowledge once.",
    tools: [],
  })
  let now = new Date()
  const initial = now.getTime()
  const proof = hashSandboxControllerProof(
    randomBytes(32).toString("base64url")
  )!
  const prepared = await prepareSandboxAttempt({
    accountId: account.accountId,
    userId: account.userId,
    controllerProofHash: proof,
    now,
    request: {
      clientAttemptId: randomUUID(),
      assistantId: assistant.id,
      baseRevision: 1,
      source: "saved",
    },
  })
  if (prepared.kind !== "created")
    throw new Error(`Prepare failed: ${prepared.kind}`)
  const browser = {
    accountId: account.accountId,
    userId: account.userId,
    attemptId: prepared.attempt.attemptId,
    controllerProofHash: proof,
  }
  const owner = {
    sessionId: `session-${randomUUID()}`,
    bootId: `boot-${randomUUID()}`,
  }
  const binding = {
    organizationId: "synthetic-org",
    serviceId: "synthetic-service",
    deploymentId: "synthetic-deployment",
    agentName: "synthetic-agent",
  }
  const transport = {
    start: vi.fn<SandboxTransport["start"]>().mockResolvedValue({
      kind: "started",
      join: {
        sessionId: owner.sessionId,
        dailyRoom: "https://synthetic.daily.co/test",
        dailyToken: "synthetic-join-token",
        expiresAt: new Date(initial + 900000).toISOString(),
      },
    }),
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
    apiBase: "http://localhost:3000",
    now: () => now,
  })
  const evidence = createSandboxEvidence(() => now)
  const rows = async () => {
    const [attempt] = await getDb()
      .select()
      .from(sandboxAttempts)
      .where(eq(sandboxAttempts.id, browser.attemptId))
    const [call] = await getDb()
      .select()
      .from(calls)
      .where(eq(calls.id, attempt!.callId))
    const [ledger] = await getDb()
      .select()
      .from(sandboxEvidence)
      .where(eq(sandboxEvidence.callId, call!.id))
    const slots = await getDb()
      .select()
      .from(sandboxSlots)
      .where(eq(sandboxSlots.attemptId, browser.attemptId))
    return { attempt: attempt!, call: call!, ledger, slots }
  }
  await lifecycle.dispatch(browser)
  const agent = {
    callId: (await rows()).call.id,
    token: transport.start.mock.calls[0]![0].agentToken,
    owner,
  }
  expect(await lifecycle.register(agent)).toEqual({ kind: "ok" })
  expect(await lifecycle.claim(agent, "http://localhost:3000")).toMatchObject({
    kind: "ok",
  })
  return {
    account,
    browser,
    owner,
    binding,
    transport,
    lifecycle,
    evidence,
    agent,
    rows,
    at: (elapsed: number) => {
      now = new Date(initial + elapsed)
    },
  }
}
