import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { assistants } from '@/db/schema';
import { encryptSecret } from '@/lib/crypto';

/**
 * Server-side data access for assistants. No UI, no route handlers — P03 builds
 * those on top of these functions and extends them; they are the real thing,
 * not scaffolding to be replaced.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. **Every query is scoped by `accountId`**, which is passed in from the one
 *     resolver in `lib/account.ts` rather than read here. A function that takes
 *     an id but not an account is a cross-account read waiting to be written.
 *  2. **The read paths enumerate their columns and exclude `server_secrets`.**
 *     Not `select *` minus a later omission: enumeration fails closed when
 *     someone adds a column, whereas an omission list silently starts leaking
 *     the moment the schema grows.
 *
 * Tool-list validation is deliberately **not** here. It lands in P03 with the
 * editor, in one place shared by the form and any API path. A half-validation
 * here would be worse than none, because P03 would inherit it and assume it was
 * complete.
 */

/** Columns safe to return anywhere. `server_secrets` is absent by construction. */
const publicColumns = {
  id: assistants.id,
  accountId: assistants.accountId,
  name: assistants.name,
  voice: assistants.voice,
  accentStyle: assistants.accentStyle,
  instructions: assistants.instructions,
  backendInstructions: assistants.backendInstructions,
  backendModel: assistants.backendModel,
  waitingBehavior: assistants.waitingBehavior,
  serverUrl: assistants.serverUrl,
  tools: assistants.tools,
  createdAt: assistants.createdAt,
  updatedAt: assistants.updatedAt,
} as const;

export type AssistantInput = {
  name: string;
  voice?: string | null;
  accentStyle?: string | null;
  instructions?: string | null;
  backendInstructions?: string | null;
  backendModel?: string | null;
  waitingBehavior?: string | null;
  serverUrl?: string | null;
  /** Plaintext. Encrypted here; never stored or returned as given. */
  serverSecret?: string | null;
  tools?: unknown;
};

/**
 * A row as the public projection returns it.
 *
 * Inferred from `publicColumns` rather than hand-written, so it gains a field
 * exactly when the projection does — and so P03 can extend these functions
 * without casting at every call site. A mapped type of `unknown` would compile
 * and tell a caller nothing.
 */
export type Assistant = Pick<
  typeof assistants.$inferSelect,
  keyof typeof publicColumns
>;

/**
 * Creates an assistant owned by `accountId`.
 *
 * `serverSecret` arrives as plaintext and is encrypted before it reaches the
 * insert. It is stored in the `server_secrets` JSON **list** rather than a
 * scalar column, so rotation in a later ticket is an append rather than a
 * migration of every row.
 *
 * The created assistant is returned through the same public projection as every
 * other read, so the secret cannot escape through the create path either.
 */
export async function createAssistant(
  accountId: string,
  input: AssistantInput,
): Promise<Assistant> {
  // An empty string means "no secret given", not "encrypt the empty string".
  // `encryptSecret` refuses an empty plaintext, so without this a form that
  // submits a blank optional field would be a 500 rather than an assistant
  // with no secret.
  const secret =
    input.serverSecret === undefined ||
    input.serverSecret === null ||
    input.serverSecret === ''
      ? null
      : input.serverSecret;

  const secrets =
    secret === null
      ? []
      : [{ id: randomUUID(), ciphertext: encryptSecret(secret) }];

  const rows = await getDb()
    .insert(assistants)
    .values({
      id: randomUUID(),
      accountId,
      name: input.name,
      voice: input.voice ?? null,
      accentStyle: input.accentStyle ?? null,
      instructions: input.instructions ?? null,
      backendInstructions: input.backendInstructions ?? null,
      backendModel: input.backendModel ?? null,
      waitingBehavior: input.waitingBehavior ?? null,
      serverUrl: input.serverUrl ?? null,
      serverSecrets: secrets,
      tools: input.tools ?? [],
    })
    .returning(publicColumns);

  return rows[0]!;
}

/**
 * One assistant, or `null`.
 *
 * `accountId` is part of the predicate rather than checked after the read: a
 * fetch-then-compare returns the row to the caller's process first, and one
 * forgotten comparison is a cross-account read. Absent and not-yours are the
 * same answer on purpose, so this cannot be used to probe which ids exist.
 */
export async function getAssistantForAccount(
  accountId: string,
  assistantId: string,
): Promise<Assistant | null> {
  const rows = await getDb()
    .select(publicColumns)
    .from(assistants)
    .where(
      and(
        eq(assistants.id, assistantId),
        eq(assistants.accountId, accountId),
        isNull(assistants.archivedAt),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/** Every live assistant owned by `accountId`. */
export async function listAssistantsForAccount(
  accountId: string,
): Promise<Assistant[]> {
  return getDb()
    .select(publicColumns)
    .from(assistants)
    .where(
      and(eq(assistants.accountId, accountId), isNull(assistants.archivedAt)),
    );
}
