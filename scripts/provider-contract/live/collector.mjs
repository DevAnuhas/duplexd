#!/usr/bin/env node

import { createServer } from "node:http"
import process from "node:process"

import {
  MAX_CALLBACK_BYTES,
  parseCallbackEvent,
  sanitizeCallbackEvent,
  verifyCallback,
} from "./protocol.mjs"

const DEFAULT_TTL_MS = 90 * 60 * 1_000

async function readBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_CALLBACK_BYTES) {
      throw new Error("callback body exceeds limit")
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function createCollector({
  secret,
  runId,
  caseIds,
  host = "127.0.0.1",
  port = 0,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
}) {
  const allowedCases = new Set(caseIds)
  const nonces = new Set()
  const events = new Map()
  const waiters = new Map()
  let closed = false

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/probe-events") {
        response.writeHead(404).end()
        return
      }
      const body = await readBody(request)
      const timestamp = request.headers["x-duplexd-contract-timestamp"]
      const nonce = request.headers["x-duplexd-contract-nonce"]
      const signature = request.headers["x-duplexd-contract-signature"]
      if (
        typeof timestamp !== "string" ||
        typeof nonce !== "string" ||
        typeof signature !== "string"
      ) {
        response.writeHead(401).end()
        return
      }
      const verified = verifyCallback({
        secret,
        timestamp,
        nonce,
        signature,
        body,
        nowSeconds: Math.floor(now() / 1_000),
      })
      if (!verified.ok || nonces.has(nonce)) {
        response.writeHead(401).end()
        return
      }
      nonces.add(nonce)
      const event = parseCallbackEvent(body, {
        runId,
        caseIds: allowedCases,
      })
      const key = `${event.bootId}:${event.event}`
      if (events.has(key)) {
        const prior = events.get(key)
        response
          .writeHead(
            JSON.stringify(prior) === JSON.stringify(event) ? 204 : 409
          )
          .end()
        return
      }
      events.set(key, event)
      for (const resolve of waiters.get(key) ?? []) resolve(event)
      waiters.delete(key)
      response.writeHead(204).end()
    } catch {
      response.writeHead(400).end()
    }
  })

  const expiry = setTimeout(() => {
    void close()
  }, ttlMs)
  expiry.unref()

  async function listen() {
    if (closed) {
      throw new Error("collector is closed")
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, host, resolve)
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("collector did not bind a TCP port")
    }
    return { host, port: address.port }
  }

  async function close() {
    if (closed) return
    closed = true
    clearTimeout(expiry)
    events.clear()
    nonces.clear()
    for (const pending of waiters.values()) {
      for (const resolve of pending) resolve(null)
    }
    waiters.clear()
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }

  return {
    listen,
    close,
    rawEvent(bootId, event) {
      return events.get(`${bootId}:${event}`) ?? null
    },
    waitFor(bootId, event) {
      const key = `${bootId}:${event}`
      const current = events.get(key)
      if (current !== undefined) return Promise.resolve(current)
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => {
        const pending = waiters.get(key) ?? []
        pending.push(resolve)
        waiters.set(key, pending)
      })
    },
    sanitizedEvents() {
      return [...events.values()].map(sanitizeCallbackEvent)
    },
  }
}

async function main() {
  const secret = process.env.PROVIDER_CONTRACT_HMAC_SECRET
  const runId = process.env.PROVIDER_CONTRACT_RUN_ID
  const caseIds =
    process.env.PROVIDER_CONTRACT_CASE_IDS?.split(",").filter(Boolean)
  if (!secret || !runId || !caseIds || caseIds.length === 0) {
    throw new Error(
      "PROVIDER_CONTRACT_HMAC_SECRET, PROVIDER_CONTRACT_RUN_ID and PROVIDER_CONTRACT_CASE_IDS are required"
    )
  }
  const collector = createCollector({ secret, runId, caseIds })
  const address = await collector.listen()
  process.stdout.write(
    `${JSON.stringify({ state: "ready", host: address.host, port: address.port })}\n`
  )
  const stop = async () => {
    await collector.close()
    process.exitCode = 0
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "collector failed"}\n`
    )
    process.exitCode = 1
  })
}
