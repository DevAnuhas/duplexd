import {
  fingerprintToolInputSchema,
  type PracticeSampleDefinition,
} from "./configuration"
import { rileyAssistantTemplate } from "@/lib/riley"

export const RILEY_PRACTICE_TEMPLATE_VERSION = "riley-practice-v1" as const

/** Pure template: no database, environment, network, or customer-data access. */
export function rileyPracticeTemplate() {
  const assistant = rileyAssistantTemplate()
  const tool = assistant.tools[0]!
  const fingerprint = fingerprintToolInputSchema(tool)
  const sample: PracticeSampleDefinition = {
    toolName: tool.name,
    inputSchemaFingerprint: fingerprint,
    reviewedFingerprint: fingerprint,
    defaultResult: {
      property: "Pine House (fictional sample)",
      parking: "Two marked spaces are available beside the house.",
      checkout: "Sample checkout time is 10:00 AM.",
      amenities: ["Wi-Fi", "kitchen", "washer"],
      synthetic: true,
    },
    overrides: [
      {
        name: "unavailable",
        result: {
          status: "unavailable",
          message: "That information is unavailable in this synthetic sample.",
          synthetic: true,
        },
      },
    ],
  }
  return structuredClone({
    version: RILEY_PRACTICE_TEMPLATE_VERSION,
    assistant,
    samples: [sample],
  })
}
