import { z } from 'zod';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const AppendKindSchema = z.enum([
  'thinking',
  'commentary',
  'instruction',
]);
export type AppendKind = z.infer<typeof AppendKindSchema>;

export const IsoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
    'Expected an ISO-8601 timestamp',
  );

export const UsageSchema = z.strictObject({
  seconds: z.number().nonnegative(),
  raw: JsonValueSchema,
});
export type Usage = z.infer<typeof UsageSchema>;

export const TranscriptFragmentSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  offsetMs: z.number().int().nonnegative(),
});
export type TranscriptFragment = z.infer<typeof TranscriptFragmentSchema>;
