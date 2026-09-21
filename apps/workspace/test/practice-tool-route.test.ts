import { describe, expect, it } from "vitest"

import { POST } from "@/app/v1/practice/calls/[callId]/tools/route"
import { MAX_PRACTICE_WEBHOOK_BYTES } from "@/practice/samples"

const context = { params: Promise.resolve({ callId: "bounded-call" }) }

describe("Practice tool route request bounds", () => {
  it("requires JSON before reading a body", async () => {
    const response = await POST(
      new Request(
        "http://localhost:3000/v1/practice/calls/bounded-call/tools",
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "not json",
        }
      ),
      context
    )

    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({
      code: "invalid_content_type",
    })
  })

  it("rejects a declared oversized body before reading it", async () => {
    const response = await POST(
      new Request(
        "http://localhost:3000/v1/practice/calls/bounded-call/tools",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_PRACTICE_WEBHOOK_BYTES + 1),
          },
          body: "{}",
        }
      ),
      context
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: "request_too_large" })
  })

  it("rejects an actually oversized chunked body", async () => {
    const response = await POST(
      new Request(
        "http://localhost:3000/v1/practice/calls/bounded-call/tools",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"padding":"${"x".repeat(MAX_PRACTICE_WEBHOOK_BYTES)}"}`,
        }
      ),
      context
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: "request_too_large" })
  })
})
