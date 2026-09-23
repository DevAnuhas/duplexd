import { expect, it } from "vitest"

import { practiceProbeAllowed } from "@/sandbox/client/background-probe"

it("keeps the experimental timing probe off production and unrelated previews", () => {
  expect(
    practiceProbeAllowed("duplexd-anuhas-projects.vercel.app", "?practiceProbe")
  ).toBe(false)
  expect(
    practiceProbeAllowed(
      "duplexd-git-feat-83-compact-assistant-editor-anuhas-projects.vercel.app",
      "?practiceProbe"
    )
  ).toBe(false)
  expect(
    practiceProbeAllowed(
      "duplexd-git-feat-82-practice-background-796959-anuhas-projects.vercel.app",
      ""
    )
  ).toBe(false)
  expect(
    practiceProbeAllowed(
      "duplexd-git-feat-82-practice-background-796959-anuhas-projects.vercel.app",
      "?practiceProbe"
    )
  ).toBe(true)
})
