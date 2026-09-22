import { notFound } from "next/navigation"

import { getAssistantForAccount } from "@/data/assistants"
import { requireShell } from "../../../shell-data"
import { Sandbox } from "./sandbox"

export const dynamic = "force-dynamic"

export default async function SandboxPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { account } = await requireShell()
  const { id } = await params
  const assistant = await getAssistantForAccount(account.id, id)
  if (assistant === null) notFound()

  return (
    <Sandbox
      assistant={{
        id,
        name: assistant.name,
        revision: assistant.revision,
        voice: assistant.voice,
        backendModel: assistant.backendModel,
      }}
    />
  )
}
