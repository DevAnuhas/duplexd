import Link from "next/link"

import { Button } from "@/components/ui/button"

export function AssistantNavigation({
  assistantId,
  active,
  hasUnsavedChanges = false,
}: {
  assistantId: string
  active: "configure" | "practice" | "calls"
  hasUnsavedChanges?: boolean
}) {
  return (
    <div>
      <nav
        aria-label="Assistant navigation"
        className="flex gap-1 overflow-x-auto border-b"
      >
        <Button
          asChild
          variant="ghost"
          className={`min-h-11 shrink-0 rounded-none border-b-2 px-5 ${active === "configure" ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground"}`}
        >
          <Link
            href={`/assistants/${assistantId}`}
            aria-current={active === "configure" ? "page" : undefined}
          >
            Configure
          </Link>
        </Button>
        {hasUnsavedChanges ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 shrink-0"
            disabled
          >
            Practice
          </Button>
        ) : (
          <Button
            asChild
            variant="ghost"
            className={`min-h-11 shrink-0 rounded-none border-b-2 px-5 ${active === "practice" ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground"}`}
          >
            <Link
              href={`/assistants/${assistantId}/sandbox`}
              aria-current={active === "practice" ? "page" : undefined}
            >
              Practice
            </Link>
          </Button>
        )}
        <Button
          asChild
          variant="ghost"
          className={`min-h-11 shrink-0 rounded-none border-b-2 px-5 ${active === "calls" ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground"}`}
        >
          <Link
            href={`/assistants/${assistantId}/calls`}
            aria-current={active === "calls" ? "page" : undefined}
          >
            Calls
          </Link>
        </Button>
      </nav>
      {hasUnsavedChanges && (
        <p className="mt-2 text-sm text-muted-foreground">
          Save your changes before opening Practice. This version tests saved
          configurations only.
        </p>
      )}
    </div>
  )
}
