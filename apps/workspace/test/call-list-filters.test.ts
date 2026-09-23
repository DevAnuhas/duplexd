import { expect, it } from "vitest"

import { parseCallListFilters } from "@/data/call-list-filters"

it("accepts only the source and Practice mode combinations the UI offers", () => {
  expect(parseCallListFilters({})).toStrictEqual({
    source: "all",
    mode: "all",
    cursor: null,
  })
  expect(
    parseCallListFilters({
      source: "sandbox",
      mode: "practice",
      cursor: "opaque",
    })
  ).toStrictEqual({ source: "sandbox", mode: "practice", cursor: "opaque" })
  for (const input of [
    { source: "unknown" },
    { source: "integration", mode: "practice" },
    { source: "all", mode: "practice" },
    { mode: "unknown" },
    { source: ["sandbox", "integration"] },
    { mode: ["practice"] },
    { cursor: ["first", "second"] },
  ]) {
    expect(parseCallListFilters(input)).toBeNull()
  }
})
