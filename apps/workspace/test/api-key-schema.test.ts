import { describe, expect, it } from "vitest"

import { apiKeyNameSchema } from "@/lib/api-key-schemas"

describe("API key name schema", () => {
  it("accepts names from 1 through 80 characters", () => {
    expect(apiKeyNameSchema.parse({ name: "a" })).toEqual({ name: "a" })
    expect(apiKeyNameSchema.parse({ name: "a".repeat(80) })).toEqual({
      name: "a".repeat(80),
    })
  })

  it("trims the value shared by the form and server action", () => {
    expect(apiKeyNameSchema.parse({ name: "  Production backend  " })).toEqual({
      name: "Production backend",
    })
  })

  it.each(["", "   ", "a".repeat(81)])("rejects %j", (name) => {
    expect(apiKeyNameSchema.safeParse({ name }).success).toBe(false)
  })
})
