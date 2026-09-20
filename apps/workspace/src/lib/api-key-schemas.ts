import { z } from "zod"

/**
 * Shared by the mint form and its server action so the browser cannot accept a
 * key name that the authenticated write path rejects (or vice versa).
 */
export const apiKeyNameSchema = z.object({
  name: z
    .string({ error: "Enter a name for this key." })
    .trim()
    .min(1, {
      error: "A key needs a name so you can tell it apart later.",
    })
    .max(80, { error: "Key names must be 80 characters or fewer." }),
})

export type ApiKeyNameValues = z.infer<typeof apiKeyNameSchema>
