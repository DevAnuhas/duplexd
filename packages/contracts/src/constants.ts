export const CONTRACT_VERSION = '1' as const;
export const APPEND_TOKEN_BUDGET = 500;
export const MAX_CONTENT_CHARS = 500;
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
export const MIN_HANDLER_TIMEOUT_MS = 1_000;
export const MAX_HANDLER_TIMEOUT_MS = 120_000;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const MAX_NDJSON_LINE_BYTES = 65_536;
export const SCHEMA_DRAFT =
  'https://json-schema.org/draft/2020-12/schema' as const;

export const HANDLER_URL_PATTERN =
  /^(?:https:\/\/(?:\[[0-9a-fA-F:]+\]|[^\s@/?#:[\]]+)(?::[0-9]+)?(?:[/?][^\s#]*)?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?][^\s#]*)?)$/;
