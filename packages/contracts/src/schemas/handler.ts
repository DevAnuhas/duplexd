import { z } from 'zod';

import { CONTRACT_VERSION, MAX_CONTENT_CHARS } from '../constants.js';
import { JsonValueSchema } from './shared.js';

type SchemaMode = 'strict' | 'loose';
const objectFor = (mode: SchemaMode) =>
  mode === 'strict' ? z.strictObject : z.looseObject;

export function handlerRequestSchema(mode: SchemaMode) {
  const object = objectFor(mode);
  return object({
    contractVersion: z.literal(CONTRACT_VERSION),
    sessionId: z.string().min(1),
    delegationId: z.string().min(1),
    offsetMs: z.number().int().nonnegative(),
    transcript: z.array(
      object({
        role: z.enum(['user', 'assistant']),
        text: z.string(),
        offsetMs: z.number().int().nonnegative(),
      }),
    ),
    consumerContext: JsonValueSchema.optional(),
    priorDelegations: z.array(
      object({
        delegationId: z.string().min(1),
        outcome: z.enum(['done', 'timeout', 'cancelled', 'error', 'running']),
      }),
    ),
  });
}

export const HandlerRequestStrict = handlerRequestSchema('strict');
export type HandlerRequestStrict = z.infer<typeof HandlerRequestStrict>;
export const HandlerRequestLoose = handlerRequestSchema('loose');
export type HandlerRequestLoose = z.infer<typeof HandlerRequestLoose>;

const content = z.string().max(MAX_CONTENT_CHARS);
export const HandlerResult = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('thinking'), content }),
  z.looseObject({ kind: z.literal('commentary'), content }),
  z.looseObject({ kind: z.literal('instruction'), content }),
  z.looseObject({ kind: z.literal('done') }),
  z.looseObject({ kind: z.literal('error'), message: z.string() }),
]);
export type HandlerResult = z.infer<typeof HandlerResult>;
