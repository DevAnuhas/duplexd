import { createAssistantAction } from "@/app/actions"
import { requireShell } from "../../shell-data"
import { AssistantForm } from "../assistant-form"

export const dynamic = "force-dynamic"

export default async function NewAssistantPage() {
  await requireShell()

  return (
    <AssistantForm
      values={{ hasServerSecret: false }}
      action={createAssistantAction}
      submitLabel="Create assistant"
    />
  )
}
