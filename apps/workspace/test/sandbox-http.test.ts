import { describe, expect, it } from "vitest"

import { readBoundedJsonObject } from "@/sandbox/http"

describe("bounded Sandbox JSON bodies", () => {
  it("cancels a chunked body as soon as it crosses the byte limit", async () => {
    let pulls = 0
    let canceled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          if (pulls <= 5) {
            controller.enqueue(new Uint8Array(3_000))
          } else {
            controller.close()
          }
        },
        cancel() {
          canceled = true
        },
      },
      { highWaterMark: 0 }
    )
    const request = new Request("http://localhost/sandbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" })

    expect(request.headers.has("content-length")).toBe(false)
    const result = await readBoundedJsonObject(request, 4_096)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("oversized stream was accepted")
    expect(result.response.status).toBe(413)
    expect(await result.response.json()).toMatchObject({
      code: "request_too_large",
    })
    expect(canceled).toBe(true)
    expect(pulls).toBe(2)
    expect(request.body?.locked).toBe(false)
  })
})
