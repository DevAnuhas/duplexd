import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import {
  AGENT_SEQUENCE_LIMIT,
  CALL_RATE_LIMIT,
  CALL_RATE_WINDOW_MS,
  DELEGATION_TIMEOUT_SECS,
  FUNCTION_CALL_TIMEOUT_SECS,
  PLATFORM_CORRECTION_SEQUENCE,
  PLATFORM_SWEEP_SEQUENCE,
  WEBHOOK_TIMEOUT_SECS,
  type AgentEndReason,
} from '@/control/constants';
import { deriveStaleTransition, staleCutoffs } from '@/control/staleness';
import {
  getAssistantRuntimeSourceForAccount,
  type AssistantRuntimeSource,
} from '@/data/assistants';
import { getDb } from '@/db/client';
import {
  apiKeys,
  assistants,
  callEvents,
  callRateLimits,
  calls,
} from '@/db/schema';
import { decryptSecret, secretsMatch } from '@/lib/crypto';
import { hashCredential, mintAgentToken } from '@/lib/credentials';

type StoredTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AssistantSnapshot = {
  assistantId: string;
  voice: string;
  instructions: string;
  accentStyle: string;
  waitingBehavior: string;
  backendModel: string;
  backendInstructions: string;
  serverUrl: string;
  serverSecretCiphertext: string;
  tools: StoredTool[];
};

export type AgentConfigDocument = Omit<
  AssistantSnapshot,
  'serverSecretCiphertext'
> & {
  serverSecret: string;
  webhookTimeoutSecs: number;
  functionCallTimeoutSecs: number;
  delegationTimeoutSecs: number;
};

type PublicCallRow = {
  id: string;
  assistantId: string | null;
  apiKeyId: string | null;
  pipecatSessionId: string | null;
  dailyRoom: string | null;
  state: string;
  endedReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSecs: number | null;
  lastHeartbeatAt: Date | null;
};

export type PublicCall = Omit<
  PublicCallRow,
  'createdAt' | 'startedAt' | 'endedAt' | 'lastHeartbeatAt'
> & {
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastHeartbeatAt: string | null;
};

export type PublicCallEvent = {
  seq: number;
  at: string;
  type: string;
};

export type WorkspaceCall = PublicCall & {
  assistantName: string | null;
  apiKey: { name: string; prefix: string } | null;
};

type TranscriptPayload = { text: string };
type ToolStartedPayload = { tool: string; invocationId: string };
type ToolFinishedPayload = {
  tool: string;
  invocationId: string;
  outcome: 'success' | 'failure';
  durationMs: number;
  status?: number;
  errorCategory?: string;
};

export type WorkspaceCallEvent = PublicCallEvent & {
  payload?: TranscriptPayload | ToolStartedPayload | ToolFinishedPayload;
};

export type WorkspaceCallEventRow = {
  seq: number;
  at: Date;
  type: string;
  payload: unknown;
};

const ERROR_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  webhook_destination_refused: 'Destination refused',
  webhook_unreachable: 'Unreachable',
  webhook_internal_error: 'Internal error',
  webhook_http_error: 'HTTP error',
  webhook_invalid_response: 'Invalid response',
  webhook_failed: 'Failed',
};

const publicCallColumns = {
  id: calls.id,
  assistantId: calls.assistantId,
  apiKeyId: calls.apiKeyId,
  pipecatSessionId: calls.pipecatSessionId,
  dailyRoom: calls.dailyRoom,
  state: calls.state,
  endedReason: calls.endedReason,
  createdAt: calls.createdAt,
  startedAt: calls.startedAt,
  endedAt: calls.endedAt,
  durationSecs: calls.durationSecs,
  lastHeartbeatAt: calls.lastHeartbeatAt,
} as const;

function publicCall(row: PublicCallRow, now = new Date()): PublicCall {
  const transition = deriveStaleTransition(row, now);
  const projected = transition === null ? row : { ...row, ...transition };

  return {
    ...projected,
    createdAt: projected.createdAt.toISOString(),
    startedAt: projected.startedAt?.toISOString() ?? null,
    endedAt: projected.endedAt?.toISOString() ?? null,
    lastHeartbeatAt: projected.lastHeartbeatAt?.toISOString() ?? null,
  };
}

/**
 * Projects stored agent events for the authenticated workspace UI.
 *
 * This is deliberately a pick-known-keys boundary. Event ingestion validates
 * event types but payloads are agent-controlled JSON, so spreading a stored
 * payload here could expose future secret or customer-data fields by accident.
 */
export function projectWorkspaceCallEvent(
  event: WorkspaceCallEventRow,
): WorkspaceCallEvent {
  const envelope: PublicCallEvent = {
    seq: event.seq,
    at: event.at.toISOString(),
    type: event.type,
  };
  const value = event.payload;

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return envelope;
  }

  const payload = value as Record<string, unknown>;

  if (
    event.type === 'transcript_user' ||
    event.type === 'transcript_assistant'
  ) {
    return typeof payload.text === 'string'
      ? { ...envelope, payload: { text: payload.text } }
      : envelope;
  }

  if (event.type === 'tool_started') {
    return typeof payload.tool === 'string' &&
      typeof payload.invocationId === 'string'
      ? {
          ...envelope,
          payload: {
            tool: payload.tool,
            invocationId: payload.invocationId,
          },
        }
      : envelope;
  }

  if (event.type !== 'tool_finished') {
    return envelope;
  }

  if (
    typeof payload.tool !== 'string' ||
    typeof payload.invocationId !== 'string' ||
    (payload.outcome !== 'success' && payload.outcome !== 'failure') ||
    typeof payload.durationMs !== 'number' ||
    !Number.isFinite(payload.durationMs) ||
    payload.durationMs < 0 ||
    (payload.status !== undefined &&
      (!Number.isInteger(payload.status) ||
        Number(payload.status) < 100 ||
        Number(payload.status) > 599)) ||
    (payload.errorCategory !== undefined &&
      typeof payload.errorCategory !== 'string')
  ) {
    return envelope;
  }

  const projected: ToolFinishedPayload = {
    tool: payload.tool,
    invocationId: payload.invocationId,
    outcome: payload.outcome,
    durationMs: payload.durationMs,
  };

  if (payload.status !== undefined) {
    projected.status = Number(payload.status);
  }
  if (payload.errorCategory !== undefined) {
    projected.errorCategory =
      Object.hasOwn(ERROR_CATEGORY_LABELS, payload.errorCategory)
        ? ERROR_CATEGORY_LABELS[payload.errorCategory]
        : 'Failed';
  }

  return { ...envelope, payload: projected };
}

export function projectWorkspaceCallEvents(
  events: WorkspaceCallEventRow[],
): WorkspaceCallEvent[] {
  return events.map((event) => projectWorkspaceCallEvent(event));
}

function privateSecretCiphertext(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const first = value[0];
  if (first === null || typeof first !== 'object') {
    return null;
  }

  const ciphertext = (first as { ciphertext?: unknown }).ciphertext;
  return typeof ciphertext === 'string' && ciphertext !== ''
    ? ciphertext
    : null;
}

function projectTools(value: unknown): StoredTool[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const projected: StoredTool[] = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    const tool = entry as Record<string, unknown>;
    const parameters = tool.parameters;

    if (
      typeof tool.name !== 'string' ||
      typeof tool.description !== 'string' ||
      parameters === null ||
      typeof parameters !== 'object' ||
      Array.isArray(parameters)
    ) {
      return null;
    }

    projected.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: parameters as Record<string, unknown>,
      },
    });
  }

  return projected;
}

function buildSnapshot(source: AssistantRuntimeSource): {
  snapshot: AssistantSnapshot | null;
  missing: string[];
} {
  const missing: string[] = [];
  const nonEmptyFields = [
    ['voice', source.voice],
    ['instructions', source.instructions],
    ['backendModel', source.backendModel],
    ['backendInstructions', source.backendInstructions],
    ['serverUrl', source.serverUrl],
  ] as const;

  for (const [name, value] of nonEmptyFields) {
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(name);
    }
  }

  if (typeof source.accentStyle !== 'string') {
    missing.push('accentStyle');
  }
  if (typeof source.waitingBehavior !== 'string') {
    missing.push('waitingBehavior');
  }

  const serverSecretCiphertext = privateSecretCiphertext(source.serverSecrets);
  if (serverSecretCiphertext === null) {
    missing.push('serverSecret');
  }

  const tools = projectTools(source.tools);
  if (tools === null) {
    missing.push('tools');
  }

  if (missing.length > 0 || tools === null || serverSecretCiphertext === null) {
    return { snapshot: null, missing };
  }

  return {
    missing: [],
    snapshot: {
      assistantId: source.id,
      voice: source.voice!,
      instructions: source.instructions!,
      accentStyle: source.accentStyle!,
      waitingBehavior: source.waitingBehavior!,
      backendModel: source.backendModel!,
      backendInstructions: source.backendInstructions!,
      serverUrl: source.serverUrl!,
      serverSecretCiphertext,
      tools,
    },
  };
}

export async function prepareCallCreation(
  accountId: string,
  assistantId: string,
): Promise<
  | { kind: 'not_found' }
  | { kind: 'invalid_config'; missing: string[] }
  | { kind: 'ready'; snapshot: AssistantSnapshot }
> {
  const source = await getAssistantRuntimeSourceForAccount(
    accountId,
    assistantId,
  );

  if (source === null) {
    return { kind: 'not_found' };
  }

  const result = buildSnapshot(source);

  return result.snapshot === null
    ? { kind: 'invalid_config', missing: result.missing }
    : { kind: 'ready', snapshot: result.snapshot };
}

export async function consumeCallCreationSlot(
  apiKeyId: string,
  now = new Date(),
): Promise<boolean> {
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / CALL_RATE_WINDOW_MS) * CALL_RATE_WINDOW_MS,
  );

  const rows = await getDb()
    .insert(callRateLimits)
    .values({ apiKeyId, windowStartedAt, count: 1 })
    .onConflictDoUpdate({
      target: [callRateLimits.apiKeyId, callRateLimits.windowStartedAt],
      set: { count: sql`${callRateLimits.count} + 1` },
      setWhere: lt(callRateLimits.count, CALL_RATE_LIMIT),
    })
    .returning({ count: callRateLimits.count });

  return rows.length === 1;
}

export async function insertStartingCall(input: {
  accountId: string;
  assistantId: string;
  apiKeyId: string;
  snapshot: AssistantSnapshot;
  now?: Date;
}): Promise<{ callId: string; agentToken: string }> {
  const callId = randomUUID();
  const token = mintAgentToken();

  await getDb()
    .insert(calls)
    .values({
      id: callId,
      accountId: input.accountId,
      assistantId: input.assistantId,
      apiKeyId: input.apiKeyId,
      assistantSnapshot: input.snapshot,
      agentTokenHash: token.hash,
      state: 'starting',
      createdAt: input.now ?? new Date(),
    });

  return { callId, agentToken: token.raw };
}

export async function markCallStarted(
  callId: string,
  result: { sessionId: string; dailyRoom: string },
): Promise<void> {
  await getDb()
    .update(calls)
    .set({
      pipecatSessionId: result.sessionId,
      dailyRoom: result.dailyRoom,
    })
    .where(and(eq(calls.id, callId), eq(calls.state, 'starting')));
}

export async function markCallStartFailed(
  callId: string,
  reason: 'capacity_exceeded' | 'upstream_unavailable',
  now = new Date(),
): Promise<void> {
  await getDb()
    .update(calls)
    .set({ state: 'failed', endedReason: reason, endedAt: now })
    .where(and(eq(calls.id, callId), eq(calls.state, 'starting')));
}

export async function getCallForAccount(
  accountId: string,
  callId: string,
): Promise<{ call: PublicCall; events: PublicCallEvent[] } | null> {
  const rows = await getDb()
    .select(publicCallColumns)
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.accountId, accountId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  const events = await getDb()
    .select({ seq: callEvents.seq, at: callEvents.at, type: callEvents.type })
    .from(callEvents)
    .where(eq(callEvents.callId, callId))
    .orderBy(callEvents.seq);

  return {
    call: publicCall(row),
    events: events.map((event) => ({ ...event, at: event.at.toISOString() })),
  };
}

type WorkspaceCallRow = PublicCallRow & {
  assistantName: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
};

const workspaceCallColumns = {
  ...publicCallColumns,
  assistantName: assistants.name,
  apiKeyName: apiKeys.name,
  apiKeyPrefix: apiKeys.prefix,
} as const;

function workspaceCall(row: WorkspaceCallRow): WorkspaceCall {
  return {
    ...publicCall(row),
    assistantName: row.assistantName,
    apiKey:
      row.apiKeyName === null || row.apiKeyPrefix === null
        ? null
        : { name: row.apiKeyName, prefix: row.apiKeyPrefix },
  };
}

/** Workspace-only call detail. The public API projection stays payload-free. */
export async function getWorkspaceCallForAccount(
  accountId: string,
  callId: string,
): Promise<{ call: WorkspaceCall; events: WorkspaceCallEvent[] } | null> {
  const rows = await getDb()
    .select(workspaceCallColumns)
    .from(calls)
    .leftJoin(
      assistants,
      and(
        eq(assistants.id, calls.assistantId),
        eq(assistants.accountId, accountId),
      ),
    )
    .leftJoin(
      apiKeys,
      and(eq(apiKeys.id, calls.apiKeyId), eq(apiKeys.accountId, accountId)),
    )
    .where(and(eq(calls.id, callId), eq(calls.accountId, accountId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  // Keep this query strictly after the account-scoped call lookup and null
  // guard. Running both in Promise.all would expose events for a guessed call
  // id before tenancy is established. The joined account predicate is defense
  // in depth; do not remove either boundary.
  const storedEvents = await getDb()
    .select({
      seq: callEvents.seq,
      at: callEvents.at,
      type: callEvents.type,
      payload: callEvents.payload,
    })
    .from(callEvents)
    .innerJoin(calls, eq(calls.id, callEvents.callId))
    .where(and(eq(callEvents.callId, callId), eq(calls.accountId, accountId)))
    .orderBy(callEvents.seq);

  return {
    call: workspaceCall(row),
    events: projectWorkspaceCallEvents(storedEvents),
  };
}

type Cursor = { createdAt: Date; id: string };

function decodeCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return null;
    }
    const [createdAtValue, id] = parsed;
    if (
      typeof createdAtValue !== 'string' ||
      typeof id !== 'string' ||
      id === ''
    ) {
      return null;
    }
    const createdAt = new Date(createdAtValue);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

function encodeCursor(row: PublicCallRow): string {
  return Buffer.from(
    JSON.stringify([row.createdAt.toISOString(), row.id]),
    'utf8',
  ).toString('base64url');
}

export async function listCallsForAccount(
  accountId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<
  | { kind: 'invalid_cursor' }
  | { kind: 'ok'; calls: PublicCall[]; nextCursor: string | null }
> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const cursor =
    options.cursor === undefined || options.cursor === null
      ? null
      : decodeCursor(options.cursor);

  if (options.cursor != null && cursor === null) {
    return { kind: 'invalid_cursor' };
  }

  const predicate =
    cursor === null
      ? eq(calls.accountId, accountId)
      : and(
          eq(calls.accountId, accountId),
          or(
            lt(calls.createdAt, cursor.createdAt),
            and(eq(calls.createdAt, cursor.createdAt), lt(calls.id, cursor.id)),
          ),
        );

  const rows = await getDb()
    .select(publicCallColumns)
    .from(calls)
    .where(predicate)
    .orderBy(desc(calls.createdAt), desc(calls.id))
    .limit(limit + 1);

  const hasNext = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    kind: 'ok',
    calls: page.map((row) => publicCall(row)),
    nextCursor: hasNext && last !== undefined ? encodeCursor(last) : null,
  };
}

export async function listWorkspaceCallsForAccount(
  accountId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<
  | { kind: 'invalid_cursor' }
  | { kind: 'ok'; calls: WorkspaceCall[]; nextCursor: string | null }
> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const cursor =
    options.cursor === undefined || options.cursor === null
      ? null
      : decodeCursor(options.cursor);

  if (options.cursor != null && cursor === null) {
    return { kind: 'invalid_cursor' };
  }

  const predicate =
    cursor === null
      ? eq(calls.accountId, accountId)
      : and(
          eq(calls.accountId, accountId),
          or(
            lt(calls.createdAt, cursor.createdAt),
            and(eq(calls.createdAt, cursor.createdAt), lt(calls.id, cursor.id)),
          ),
        );

  const rows = await getDb()
    .select(workspaceCallColumns)
    .from(calls)
    .leftJoin(
      assistants,
      and(
        eq(assistants.id, calls.assistantId),
        eq(assistants.accountId, accountId),
      ),
    )
    .leftJoin(
      apiKeys,
      and(eq(apiKeys.id, calls.apiKeyId), eq(apiKeys.accountId, accountId)),
    )
    .where(predicate)
    .orderBy(desc(calls.createdAt), desc(calls.id))
    .limit(limit + 1);

  const hasNext = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    kind: 'ok',
    calls: page.map((row) => workspaceCall(row)),
    nextCursor: hasNext && last !== undefined ? encodeCursor(last) : null,
  };
}

export type AgentAuthFailure = 'not_found' | 'invalid_token' | 'expired_token';

type AuthenticatedAgentCall = {
  state: string;
  configClaimedAt: Date | null;
  snapshot: AssistantSnapshot;
};

async function authenticateAgentCall(
  callId: string,
  rawToken: string,
): Promise<
  { kind: 'ok'; call: AuthenticatedAgentCall } | { kind: AgentAuthFailure }
> {
  const rows = await getDb()
    .select({
      state: calls.state,
      tokenHash: calls.agentTokenHash,
      configClaimedAt: calls.configClaimedAt,
      snapshot: calls.assistantSnapshot,
    })
    .from(calls)
    .where(eq(calls.id, callId))
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    return { kind: 'not_found' };
  }

  const suppliedHash = hashCredential(rawToken);
  if (!secretsMatch(row.tokenHash, suppliedHash)) {
    const belongsElsewhere = await getDb()
      .select({ id: calls.id })
      .from(calls)
      .where(eq(calls.agentTokenHash, suppliedHash))
      .limit(1);

    return {
      kind: belongsElsewhere.length > 0 ? 'not_found' : 'invalid_token',
    };
  }

  if (row.state === 'ended' || row.state === 'failed') {
    return { kind: 'expired_token' };
  }

  return {
    kind: 'ok',
    call: {
      state: row.state,
      configClaimedAt: row.configClaimedAt,
      snapshot: row.snapshot as AssistantSnapshot,
    },
  };
}

export async function claimAgentConfig(
  callId: string,
  rawToken: string,
  now = new Date(),
): Promise<
  | { kind: 'ok'; config: AgentConfigDocument }
  | { kind: AgentAuthFailure | 'already_claimed' | 'unavailable' }
> {
  const auth = await authenticateAgentCall(callId, rawToken);
  if (auth.kind !== 'ok') {
    return auth;
  }

  if (auth.call.state !== 'starting' || auth.call.configClaimedAt !== null) {
    return { kind: 'already_claimed' };
  }

  const claimed = await getDb()
    .update(calls)
    .set({
      state: 'active',
      configClaimedAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
    })
    .where(
      and(
        eq(calls.id, callId),
        eq(calls.state, 'starting'),
        isNull(calls.configClaimedAt),
      ),
    )
    .returning({ id: calls.id });

  if (claimed.length !== 1) {
    return { kind: 'already_claimed' };
  }

  let serverSecret: string;
  try {
    serverSecret = decryptSecret(auth.call.snapshot.serverSecretCiphertext);
  } catch {
    await getDb()
      .update(calls)
      .set({ state: 'failed', endedReason: 'config_unavailable', endedAt: now })
      .where(and(eq(calls.id, callId), eq(calls.state, 'active')));
    return { kind: 'unavailable' };
  }

  const snapshot = auth.call.snapshot;

  return {
    kind: 'ok',
    config: {
      assistantId: snapshot.assistantId,
      voice: snapshot.voice,
      instructions: snapshot.instructions,
      accentStyle: snapshot.accentStyle,
      waitingBehavior: snapshot.waitingBehavior,
      backendModel: snapshot.backendModel,
      backendInstructions: snapshot.backendInstructions,
      serverUrl: snapshot.serverUrl,
      tools: snapshot.tools,
      serverSecret,
      webhookTimeoutSecs: WEBHOOK_TIMEOUT_SECS,
      functionCallTimeoutSecs: FUNCTION_CALL_TIMEOUT_SECS,
      delegationTimeoutSecs: DELEGATION_TIMEOUT_SECS,
    },
  };
}

export type AgentEventInput = {
  seq: number;
  /** Preserved as text until PostgreSQL parses it, retaining microseconds. */
  at: string;
  type: string;
  payload: Record<string, unknown>;
};

export async function ingestAgentEvents(
  callId: string,
  rawToken: string,
  events: AgentEventInput[],
  now = new Date(),
): Promise<{ kind: 'ok' } | { kind: AgentAuthFailure | 'not_active' }> {
  const auth = await authenticateAgentCall(callId, rawToken);
  if (auth.kind !== 'ok') {
    return auth;
  }
  if (auth.call.state !== 'active' && auth.call.state !== 'incomplete') {
    return { kind: 'not_active' };
  }

  return getDb().transaction(async (tx) => {
    const heartbeat = await tx
      .update(calls)
      .set({ lastHeartbeatAt: now })
      .where(
        and(
          eq(calls.id, callId),
          or(eq(calls.state, 'active'), eq(calls.state, 'incomplete')),
        ),
      )
      .returning({ id: calls.id });

    if (heartbeat.length !== 1) {
      return { kind: 'not_active' as const };
    }

    if (events.length > 0) {
      await tx
        .insert(callEvents)
        .values(
          events.map((event) => ({
            callId,
            seq: event.seq,
            at: sql`${event.at}::timestamptz`,
            type: event.type,
            payload: event.payload,
          })),
        )
        .onConflictDoNothing({ target: [callEvents.callId, callEvents.seq] });
    }

    return { kind: 'ok' as const };
  });
}

export async function completeAgentCall(
  callId: string,
  rawToken: string,
  completion: { endedReason: AgentEndReason; durationSecs: number },
  now = new Date(),
): Promise<{ kind: 'ok' } | { kind: AgentAuthFailure | 'not_active' }> {
  const auth = await authenticateAgentCall(callId, rawToken);
  if (auth.kind !== 'ok') {
    return auth;
  }
  if (auth.call.state !== 'active' && auth.call.state !== 'incomplete') {
    return { kind: 'not_active' };
  }

  return getDb().transaction(async (tx) => {
    const active = await tx
      .update(calls)
      .set({
        state: 'ended',
        endedReason: completion.endedReason,
        durationSecs: completion.durationSecs,
        endedAt: now,
      })
      .where(and(eq(calls.id, callId), eq(calls.state, 'active')))
      .returning({ id: calls.id });

    if (active.length === 1) {
      return { kind: 'ok' as const };
    }

    const corrected = await tx
      .update(calls)
      .set({
        state: 'ended',
        endedReason: completion.endedReason,
        durationSecs: completion.durationSecs,
        endedAt: now,
      })
      .where(and(eq(calls.id, callId), eq(calls.state, 'incomplete')))
      .returning({ id: calls.id });

    if (corrected.length !== 1) {
      return { kind: 'not_active' as const };
    }

    await tx
      .insert(callEvents)
      .values({
        callId,
        seq: PLATFORM_CORRECTION_SEQUENCE,
        at: now,
        type: 'ended',
        payload: {
          state: 'ended',
          reason: completion.endedReason,
          correctedFrom: 'incomplete',
        },
      })
      .onConflictDoNothing({ target: [callEvents.callId, callEvents.seq] });

    return { kind: 'ok' as const };
  });
}

export async function sweepStaleCalls(now = new Date()): Promise<{
  incomplete: number;
  failed: number;
}> {
  return getDb().transaction(async (tx) => {
    const cutoffs = staleCutoffs(now);
    const candidates = await tx
      .select({
        id: calls.id,
        state: calls.state,
        createdAt: calls.createdAt,
        lastHeartbeatAt: calls.lastHeartbeatAt,
      })
      .from(calls)
      .where(
        or(
          and(
            eq(calls.state, 'active'),
            lt(calls.lastHeartbeatAt, cutoffs.active),
          ),
          and(
            eq(calls.state, 'starting'),
            lt(calls.createdAt, cutoffs.starting),
          ),
        ),
      )
      .orderBy(calls.id);

    const activeIds: string[] = [];
    const startingIds: string[] = [];
    let activeTransition: ReturnType<typeof deriveStaleTransition> = null;
    let startingTransition: ReturnType<typeof deriveStaleTransition> = null;

    for (const candidate of candidates) {
      const transition = deriveStaleTransition(candidate, now);
      if (transition === null) continue;
      if (transition.state === 'incomplete') {
        activeIds.push(candidate.id);
        activeTransition = transition;
      } else {
        startingIds.push(candidate.id);
        startingTransition = transition;
      }
    }

    const staleActive =
      activeTransition === null
        ? []
        : await tx
            .update(calls)
            .set({ ...activeTransition, endedAt: now })
            .where(
              and(
                inArray(calls.id, activeIds),
                eq(calls.state, 'active'),
                lt(calls.lastHeartbeatAt, cutoffs.active),
              ),
            )
            .returning({ id: calls.id });

    const staleStarting =
      startingTransition === null
        ? []
        : await tx
            .update(calls)
            .set({ ...startingTransition, endedAt: now })
            .where(
              and(
                inArray(calls.id, startingIds),
                eq(calls.state, 'starting'),
                lt(calls.createdAt, cutoffs.starting),
              ),
            )
            .returning({ id: calls.id });

    if (staleActive.length > 0) {
      await tx
        .insert(callEvents)
        .values(
          staleActive.map((call) => ({
            callId: call.id,
            seq: PLATFORM_SWEEP_SEQUENCE,
            at: now,
            type: 'ended',
            payload: { state: 'incomplete', reason: 'agent_lost' },
          })),
        )
        .onConflictDoNothing({ target: [callEvents.callId, callEvents.seq] });
    }

    return { incomplete: staleActive.length, failed: staleStarting.length };
  });
}

export { AGENT_SEQUENCE_LIMIT };
