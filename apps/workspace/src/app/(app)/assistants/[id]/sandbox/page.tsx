import { notFound } from "next/navigation"

import { getAssistantForAccount } from "@/data/assistants"
import { compilePracticeConfiguration } from "@/practice/configuration"
import { rileyPracticeTemplate } from "@/practice/riley"
import {
  getAssistantSamplesForAccount,
  parsePracticeSampleDefinitions,
} from "@/practice/samples"
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
  const [assistant, stored] = await Promise.all([
    getAssistantForAccount(account.id, id),
    getAssistantSamplesForAccount(account.id, id),
  ])
  if (assistant === null || stored === null) notFound()

  const riley = rileyPracticeTemplate().samples
  const canUseRiley =
    stored.definitions.length === 0 &&
    parsePracticeSampleDefinitions(riley, assistant.tools).ok
  const definitions = canUseRiley ? riley : stored.definitions
  const compiled = compilePracticeConfiguration({
    assistant,
    baseRevision: assistant.revision,
    source: "saved",
    samples: definitions,
    sampleRevision: stored.revision,
  })
  const issues =
    compiled.kind === "ready"
      ? []
      : compiled.kind === "invalid"
        ? compiled.issues
        : [
            {
              field: "revision",
              message: "The assistant changed. Reload this page.",
            },
          ]

  return (
    <Sandbox
      assistant={{
        id,
        name: assistant.name,
        revision: assistant.revision,
        voice: assistant.voice,
        backendModel: assistant.backendModel,
      }}
      samples={definitions}
      sampleRevision={stored.revision}
      sampleSource={canUseRiley ? "riley" : "saved"}
      issues={issues}
    />
  )
}
