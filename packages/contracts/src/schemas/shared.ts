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
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))$/,
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
