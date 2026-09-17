import { z } from 'zod';

import { CONTRACT_VERSION } from '../constants.js';
import {
  AppendKindSchema,
  IsoTimestampSchema,
  TranscriptFragmentSchema,
  UsageSchema,
} from './shared.js';

const StoredHandlerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('remote'), url: z.string() }),
  z.strictObject({ type: z.literal('in-process') }),
]);
const StoredDelegationSchema = z.strictObject({
  delegationId: z.string().min(1),
  offsetMs: z.number().int().nonnegative(),
  outcome: z.enum(['done', 'timeout', 'cancelled', 'error', 'running']),
  createdAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema.optional(),
  appends: z.number().int().nonnegative(),
});
const StoredAppendSchema = z.strictObject({
  seq: z.number().int().min(1),
  delegationId: z.string().nullable(),
  kind: AppendKindSchema,
  tokens: z.number().int().nonnegative(),
  at: IsoTimestampSchema,
});
const StoredRejectedAppendSchema = z.strictObject({
  seq: z.number().int().min(1),
  delegationId: z.string().nullable(),
  kind: AppendKindSchema,
  reason: z.enum([
    'over_budget',
    'unknown_delegation',
    'delegation_finished',
    'provider_error',
  ]),
  at: IsoTimestampSchema,
});

const callRecordShape = {
  contractVersion: z.literal(CONTRACT_VERSION),
  sessionId: z.string().min(1),
  provider: z.literal('openai-gpt-live'),
  reason: z.string().optional(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.optional(),
  endedAt: IsoTimestampSchema,
  instructions: z.string(),
  voice: z.string().optional(),
  handler: StoredHandlerSchema,
  transcript: z.array(TranscriptFragmentSchema),
  delegations: z.array(StoredDelegationSchema),
  appends: z.array(StoredAppendSchema),
  rejectedAppends: z.array(StoredRejectedAppendSchema),
};

export const CallRecord = z.discriminatedUnion('state', [
  z.strictObject({
    ...callRecordShape,
    state: z.literal('closed'),
    usage: UsageSchema.optional(),
  }),
  z.strictObject({
    ...callRecordShape,
    state: z.literal('failed'),
  }),
  z.strictObject({
    ...callRecordShape,
    state: z.literal('incomplete'),
  }),
]);
export type CallRecord = z.infer<typeof CallRecord>;
