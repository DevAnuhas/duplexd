import { z } from 'zod';

/**
 * The editor's shared input contract. Keep tools as text: parsing validates the
 * envelope without rewriting the operator's JSON. Per-tool validation belongs
 * to the existing server validateTools function, not a second client validator.
 */
export const assistantSchema = z.object({
  name: z
    .string()
    .refine((value) => value.trim().length > 0, 'An assistant needs a name.')
    .refine(
      (value) => value.trim().length <= 120,
      'Assistant name must be 120 characters or fewer.',
    ),
  instructions: z.string(),
  voice: z.string(),
  accentStyle: z.string(),
  waitingBehavior: z.string(),
  backendModel: z.string(),
  backendInstructions: z.string(),
  serverUrl: z.string().refine((value) => {
    if (value.trim() === '') return true;
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Server URL must be a valid HTTP or HTTPS URL.'),
  serverSecret: z.string(),
  clearServerSecret: z.boolean(),
  tools: z.string().superRefine((value, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Tools must be valid JSON. Check the syntax and try again.',
      });
      return;
    }
    if (!Array.isArray(parsed)) {
      context.addIssue({ code: 'custom', message: 'Tools must be a list.' });
    }
  }),
});

export type AssistantFormInput = z.infer<typeof assistantSchema>;
