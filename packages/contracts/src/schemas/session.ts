import { z } from 'zod';

import {
  DEFAULT_HANDLER_TIMEOUT_MS,
  HANDLER_URL_PATTERN,
  MAX_HANDLER_TIMEOUT_MS,
  MIN_HANDLER_TIMEOUT_MS,
} from '../constants.js';
import { JsonValueSchema } from './shared.js';

const MAX_CONSUMER_CONTEXT_BYTES = 16 * 1024;

const ConsumerContextSchema = JsonValueSchema.refine(
  (value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MAX_CONSUMER_CONTEXT_BYTES,
  {
    message: `consumerContext must serialize to at most ${MAX_CONSUMER_CONTEXT_BYTES} UTF-8 bytes`,
  },
);

const AudioConfigSchema = z.strictObject({
  format: z.enum(['pcm16', 'g711_ulaw', 'g711_alaw']),
  sampleRateHz: z
    .union([z.literal(8_000), z.literal(16_000), z.literal(24_000)])
    .optional(),
});

const InProcessHandlerSchema = z.strictObject({
  type: z.literal('in-process'),
});
const HmacAuthSchema = z.strictObject({
  type: z.literal('hmac-sha256'),
  secret: z.string().min(16).meta({ secret: true }),
});
const RemoteHandlerSchema = z.strictObject({
  type: z.literal('remote'),
  url: z
    .string()
    .regex(
      HANDLER_URL_PATTERN,
      'handler URL must use https, or http on localhost, 127.0.0.1, or [::1]',
    ),
  auth: HmacAuthSchema,
});

export const HandlerConfigSchema = z.discriminatedUnion('type', [
  InProcessHandlerSchema,
  RemoteHandlerSchema,
]);

const sessionShape = {
  provider: z.literal('openai-gpt-live'),
  instructions: z.string().min(1).max(4_000),
  voice: z.string().optional(),
  audio: AudioConfigSchema.optional(),
  consumerContext: ConsumerContextSchema.optional(),
  handlerTimeoutMs: z
    .number()
    .int()
    .min(MIN_HANDLER_TIMEOUT_MS)
    .max(MAX_HANDLER_TIMEOUT_MS)
    .default(DEFAULT_HANDLER_TIMEOUT_MS),
};

export const SessionConfig = z.strictObject({
  ...sessionShape,
  handler: HandlerConfigSchema,
});
export type SessionConfig = z.infer<typeof SessionConfig>;

export const SessionCreateRequest = z.strictObject({
  ...sessionShape,
  handler: HandlerConfigSchema.optional(),
});
export type SessionCreateRequest = z.infer<typeof SessionCreateRequest>;
