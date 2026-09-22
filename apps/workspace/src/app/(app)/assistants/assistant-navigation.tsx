import Link from "next/link"

import { Button } from "@/components/ui/button"

export function AssistantNavigation({
  assistantId,
  active,
  hasUnsavedChanges = false,
}: {
  assistantId: string
  active: "configure" | "sandbox"
  hasUnsavedChanges?: boolean
}) {
  return (
    <div>
      <nav
        aria-label="Assistant navigation"
        className="flex flex-wrap gap-1 border-b pb-3"
      >
        <Button
          asChild
          variant={active === "configure" ? "secondary" : "ghost"}
          className="min-h-11"
        >
          <Link
            href={`/assistants/${assistantId}`}
            aria-current={active === "configure" ? "page" : undefined}
          >
            Configure
          </Link>
        </Button>
        {hasUnsavedChanges ? (
          <Button type="button" variant="ghost" className="min-h-11" disabled>
            Sandbox
          </Button>
        ) : (
          <Button
            asChild
            variant={active === "sandbox" ? "secondary" : "ghost"}
            className="min-h-11"
          >
            <Link
              href={`/assistants/${assistantId}/sandbox`}
              aria-current={active === "sandbox" ? "page" : undefined}
            >
              Sandbox
            </Link>
          </Button>
        )}
        <Button asChild variant="ghost" className="min-h-11">
          <Link href="/calls">All calls</Link>
        </Button>
      </nav>
      {hasUnsavedChanges && (
        <p className="mt-2 text-sm text-muted-foreground">
          Save your changes before opening Sandbox. This version tests saved
          configurations only.
        </p>
      )}
    </div>
  )
}
