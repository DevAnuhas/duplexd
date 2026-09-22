import Link from "next/link"

import { createAssistantAction } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { rileyAssistantTemplate } from "@/lib/riley"
import { requireShell } from "../../shell-data"
import { AssistantForm } from "../assistant-form"

export const dynamic = "force-dynamic"

export default async function NewAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>
}) {
  await requireShell()
  const isRiley = (await searchParams).template === "riley"
  return (
    <div className="flex flex-col gap-6">
      <section
        className="rounded-lg border bg-muted/30 p-6"
        aria-label="Starting configuration"
      >
        <h2 className="font-semibold">Start blank or try Riley</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Riley is a fictional property assistant with sample parking, checkout
          and amenities information. No customer connection is needed to prepare
          a Practice test. Voice calls are not available yet.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            asChild
            variant={isRiley ? "outline" : "secondary"}
            className="min-h-11"
          >
            <Link
              href="/assistants/new"
              aria-current={!isRiley ? "page" : undefined}
            >
              Blank assistant
            </Link>
          </Button>
          <Button
            asChild
            variant={isRiley ? "secondary" : "outline"}
            className="min-h-11"
          >
            <Link
              href="/assistants/new?template=riley"
              aria-current={isRiley ? "page" : undefined}
            >
              Riley sample
            </Link>
          </Button>
        </div>
      </section>
      <AssistantForm
        key={isRiley ? "riley" : "blank"}
        values={
          isRiley
            ? { ...rileyAssistantTemplate(), hasServerSecret: false }
            : { hasServerSecret: false }
        }
        action={createAssistantAction}
        submitLabel="Create assistant"
      />
    </div>
  )
}
