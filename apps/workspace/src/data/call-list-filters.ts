import type { SandboxModeFilter, WorkspaceSourceFilter } from "@/data/calls"

type Param = string | string[] | undefined

export type CallListFilters = {
  source: WorkspaceSourceFilter
  mode: SandboxModeFilter
  cursor: string | null
}

/** Shared URL contract for account and assistant history pages. */
export function parseCallListFilters(input: {
  source?: Param
  mode?: Param
  cursor?: Param
}): CallListFilters | null {
  if (
    (input.source !== undefined && typeof input.source !== "string") ||
    (input.mode !== undefined && typeof input.mode !== "string") ||
    (input.cursor !== undefined && typeof input.cursor !== "string")
  )
    return null
  const source = input.source ?? "all"
  const mode = input.mode ?? "all"
  if (source !== "all" && source !== "sandbox" && source !== "integration")
    return null
  if (mode !== "all" && mode !== "practice") return null
  if (mode === "practice" && source !== "sandbox") return null
  return { source, mode, cursor: input.cursor ?? null }
}
