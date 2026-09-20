import agentEventTypes from './agent-event-types.json';

/** Kept in JSON so the Python suite can compare its authoritative set. */
export const AGENT_EVENT_TYPES: readonly string[] = agentEventTypes;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const AGENT_END_REASONS = [
  'client_disconnected',
  'pipeline_error',
  'idle_timeout',
] as const;

export type AgentEndReason = (typeof AGENT_END_REASONS)[number];

export const AGENT_SEQUENCE_LIMIT = 1_000_000_000;
export const PLATFORM_SWEEP_SEQUENCE = AGENT_SEQUENCE_LIMIT;
export const PLATFORM_CORRECTION_SEQUENCE = AGENT_SEQUENCE_LIMIT + 1;

export const ACTIVE_STALE_AFTER_MS = 2 * 60 * 1_000;
export const STARTING_STALE_AFTER_MS = 2 * 60 * 1_000;
export const SWEEP_INTERVAL_MS = 30 * 1_000;

export const CALL_RATE_LIMIT = 10;
export const CALL_RATE_WINDOW_MS = 60 * 1_000;

export const WEBHOOK_TIMEOUT_SECS = 2;
export const FUNCTION_CALL_TIMEOUT_SECS = 5;
export const DELEGATION_TIMEOUT_SECS = 10;

if (
  WEBHOOK_TIMEOUT_SECS >= FUNCTION_CALL_TIMEOUT_SECS ||
  WEBHOOK_TIMEOUT_SECS >= DELEGATION_TIMEOUT_SECS
) {
  throw new Error(
    'WEBHOOK_TIMEOUT_SECS must stay below both agent cancellation timeouts.',
  );
}

export const PIPECAT_AGENT_NAME = 'duplexd-agent';
export const PIPECAT_START_ORIGIN = 'https://api.pipecat.daily.co';
