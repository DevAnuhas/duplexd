import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

/**
 * The platform's schema. Everything below is owned by an account; there is no
 * global object, which is what makes `account_id` the only scoping question a
 * reader has to hold in their head.
 *
 * Better Auth owns `users`, `sessions`, `auth_accounts` and `verifications`.
 * `users` is Better Auth's own table **extended** with `account_id` rather than
 * a separate table joined to it: Better Auth writes the row at signup, so a
 * separate table would need a second write that could fail independently and
 * leave a user with no account. Extending it keeps signup a single insert path
 * and makes `account_id` non-null from the first row.
 */

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/** Better Auth's credential/provider table. Named to avoid colliding with `accounts`. */
export const authAccounts = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("provider_account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * API keys.
 *
 * There is deliberately no column that can hold a raw key. `prefix` is the
 * non-secret leading segment, shown in the UI so a key is identifiable and a
 * leaked key in a log can be traced; `key_hash` is the SHA-256 of the full key
 * as 64 hex characters. Minting, constant-time comparison and revocation
 * enforcement are P03; this shape is what makes them possible without a
 * migration.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("api_keys_prefix_idx").on(table.prefix)]
)

/**
 * Assistants.
 *
 * `server_secrets` is a JSON **list** from the start, not a single column, so
 * rotation later is a feature rather than a migration of every row. Each entry
 * holds ciphertext, never plaintext — see `src/lib/crypto.ts`.
 */
export const assistants = pgTable(
  "assistants",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    voice: text("voice"),
    accentStyle: text("accent_style"),
    instructions: text("instructions"),
    backendInstructions: text("backend_instructions"),
    backendModel: text("backend_model"),
    waitingBehavior: text("waiting_behavior"),
    serverUrl: text("server_url"),
    serverSecrets: jsonb("server_secrets").notNull().default([]),
    tools: jsonb("tools").notNull().default([]),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [index("assistants_account_idx").on(table.accountId)]
)

/**
 * Calls.
 *
 * `assistant_snapshot` is the resolved runtime configuration as it was when
 * the call started. The customer's secret is present only as ciphertext, so
 * the config endpoint can serve the call's own snapshot after a rotation.
 * Every public call projection must enumerate fields and omit the snapshot —
 * ciphertext is still credential material, not a convenient opaque blob.
 *
 * `ended` is only ever written by the agent reporting completion. A call whose
 * container died is `incomplete`, written by the sweeper, with its last known
 * duration. The workspace says so rather than showing a tidy record of
 * something that never happened.
 */
export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id").references(() => assistants.id, {
      onDelete: "set null",
    }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    initiatedByUserId: text("initiated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assistantSnapshot: jsonb("assistant_snapshot").notNull(),
    source: text("source").notNull().default("integration"),
    channel: text("channel").notNull().default("browser"),
    testMode: text("test_mode"),
    configSource: text("config_source"),
    baseAssistantRevision: integer("base_assistant_revision"),
    configDigest: text("config_digest"),
    snapshotVersion: integer("snapshot_version"),
    scenarioRevision: integer("scenario_revision"),
    practiceCompilerVersion: text("practice_compiler_version"),
    practiceSnapshot: jsonb("practice_snapshot"),
    practiceSecretCiphertext: text("practice_secret_ciphertext"),
    executionDeadline: timestamp("execution_deadline", { withTimezone: true }),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    // Sandbox reservations exist before dispatch and therefore before an
    // agent token can safely exist. Integration calls still write this field
    // at insertion, exactly as before.
    agentTokenHash: text("agent_token_hash"),
    configClaimedAt: timestamp("config_claimed_at", { withTimezone: true }),
    pipecatSessionId: text("pipecat_session_id"),
    dailyRoom: text("daily_room"),
    state: text("state").notNull(),
    endedReason: text("ended_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSecs: numeric("duration_secs", {
      precision: 12,
      scale: 3,
      mode: "number",
    }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("calls_agent_token_hash_idx").on(table.agentTokenHash),
    index("calls_account_created_idx").on(
      table.accountId,
      table.createdAt.desc()
    ),
    index("calls_api_key_idx").on(table.apiKeyId),
    // Partial: the sweeper only ever looks for calls still claiming to run.
    index("calls_active_idx")
      .on(table.state)
      .where(sql`${table.state} = 'active'`),
    index("calls_starting_idx")
      .on(table.state)
      .where(sql`${table.state} = 'starting'`),
  ]
)

/**
 * One durable browser Sandbox admission attempt.
 *
 * This row owns idempotency and tab-controller proof. It deliberately has no
 * provider credential or join credential columns: the provider-independent
 * foundation cannot manufacture either while execution remains disabled.
 */
export const sandboxAttempts = pgTable(
  "sandbox_attempts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    initiatedByUserId: text("initiated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    clientAttemptId: text("client_attempt_id").notNull(),
    inputDigest: text("input_digest").notNull(),
    controllerProofHash: text("controller_proof_hash").notNull(),
    state: text("state").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reservationExpiresAt: timestamp("reservation_expires_at", {
      withTimezone: true,
    }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    stopReason: text("stop_reason"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sandbox_attempts_owner_client_idx").on(
      table.accountId,
      table.initiatedByUserId,
      table.clientAttemptId
    ),
    uniqueIndex("sandbox_attempts_call_idx").on(table.callId),
    index("sandbox_attempts_account_state_idx").on(
      table.accountId,
      table.state
    ),
    index("sandbox_attempts_reservation_expiry_idx").on(
      table.reservationExpiresAt
    ),
  ]
)

/** One unresolved Sandbox attempt per user, with an account-wide cap. */
export const sandboxSlots = pgTable(
  "sandbox_slots",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => sandboxAttempts.id, { onDelete: "cascade" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.userId] }),
    uniqueIndex("sandbox_slots_attempt_idx").on(table.attemptId),
    index("sandbox_slots_account_idx").on(table.accountId),
  ]
)

/** Atomic fixed-window Sandbox admission counters for user and account quotas. */
export const sandboxAdmissionRateLimits = pgTable(
  "sandbox_admission_rate_limits",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.accountId,
        table.subjectType,
        table.subjectId,
        table.windowStartedAt,
      ],
    }),
  ]
)

/** Authored, revisioned sample mappings for one assistant. */
export const assistantSamples = pgTable(
  "assistant_samples",
  {
    assistantId: text("assistant_id")
      .primaryKey()
      .references(() => assistants.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    definitions: jsonb("definitions").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("assistant_samples_account_idx").on(table.accountId)]
)

/** Deterministic response selected for one signed Practice invocation. */
export const practiceInvocations = pgTable(
  "practice_invocations",
  {
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    invocationId: text("invocation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    toolName: text("tool_name").notNull(),
    scenario: text("scenario").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body"),
    readyAt: timestamp("ready_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.callId, table.invocationId] })]
)

/** Append-only call events, keyed so gaps and reordering are detectable. */
export const callEvents = pgTable(
  "call_events",
  {
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    payload: jsonb("payload"),
  },
  (table) => [primaryKey({ columns: [table.callId, table.seq] })]
)

/**
 * Atomic fixed-window counters for call creation.
 *
 * A read-then-increment over `calls` races under concurrent customer retries.
 * One row per key/window lets the insert/update itself decide whether capacity
 * remains, without adding Redis for launch traffic.
 */
export const callRateLimits = pgTable(
  "call_rate_limits",
  {
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.apiKeyId, table.windowStartedAt] })]
)
