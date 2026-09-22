import { notFound } from "next/navigation"

import { getAssistantPracticeSourceForAccount } from "@/data/assistants"
import {
  getAssistantSamplesForAccount,
  parsePracticeSampleDefinitions,
} from "@/practice/samples"
import { rileyPracticeTemplate } from "@/practice/riley"
import { requireShell } from "../../shell-data"
import { AssistantDraftProvider } from "./draft-host"

export const dynamic = "force-dynamic"

export default async function AssistantLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>
  children: React.ReactNode
}) {
  const { account } = await requireShell()
  const { id } = await params
  const [assistant, samples] = await Promise.all([
    getAssistantPracticeSourceForAccount(account.id, id),
    getAssistantSamplesForAccount(account.id, id),
  ])
  if (assistant === null || samples === null) notFound()
  const riley = rileyPracticeTemplate().samples
  const suggestedDefinitions =
    samples.definitions.length === 0 &&
    parsePracticeSampleDefinitions(riley, assistant.tools).ok
      ? riley
      : undefined
  return (
    <AssistantDraftProvider
      key={id}
      seed={{
        assistantId: id,
        revision: assistant.revision,
        fields: {
          voice: assistant.voice ?? "",
          accentStyle: assistant.accentStyle ?? "",
          instructions: assistant.instructions ?? "",
          backendInstructions: assistant.backendInstructions ?? "",
          backendModel: assistant.backendModel ?? "",
          waitingBehavior: assistant.waitingBehavior ?? "",
          tools: JSON.stringify(assistant.tools ?? [], null, 2),
        },
        sampleRevision: samples.revision,
        definitions: samples.definitions,
        suggestedDefinitions,
      }}
    >
      {children}
    </AssistantDraftProvider>
  )
}
