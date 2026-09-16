import { z } from 'zod';

import {
  AppendKindSchema,
  IsoTimestampSchema,
  JsonValueSchema,
  UsageSchema,
} from './shared.js';

const event = <T extends string, S extends z.ZodRawShape>(
  type: T,
  payload: S,
) =>
  z.strictObject({
    type: z.literal(type),
    sessionId: z.string().min(1),
    seq: z.number().int().min(1),
    at: IsoTimestampSchema,
    payload: z.strictObject(payload),
  });

export const CoreEvent = z.discriminatedUnion('type', [
  event('session.started', {}),
  event('session.closing', {}),
  event('session.closed', { usage: UsageSchema }),
  event('session.failed', { reason: z.string() }),
  event('session.incomplete', {
    reason: z.enum([
      'provider_disconnected',
      'provider_final_event_missing',
      'process_shutdown',
      'instance_lost',
    ]),
  }),
  event('transcript.user.delta', {
    text: z.string(),
    offsetMs: z.number().int().nonnegative(),
  }),
  event('transcript.assistant.delta', {
    text: z.string(),
    offsetMs: z.number().int().nonnegative(),
  }),
  event('delegation.created', {
    delegationId: z.string().min(1),
    offsetMs: z.number().int().nonnegative(),
  }),
  event('delegation.finished', {
    delegationId: z.string().min(1),
    outcome: z.enum(['done', 'timeout', 'cancelled', 'error']),
    error: z.string().optional(),
  }),
  event('append.sent', {
    delegationId: z.string().nullable(),
    kind: AppendKindSchema,
    tokens: z.number().int().nonnegative(),
  }),
  event('append.rejected', {
    delegationId: z.string().nullable(),
    kind: AppendKindSchema,
    reason: z.enum([
      'over_budget',
      'unknown_delegation',
      'delegation_finished',
      'provider_error',
    ]),
    tokens: z.number().int().nonnegative().optional(),
    chars: z.number().int().nonnegative().optional(),
    detail: z.string().optional(),
  }),
  event('transport.dtmf', { digit: z.string() }),
  event('provider.raw', { event: JsonValueSchema }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;
