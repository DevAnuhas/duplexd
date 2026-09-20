import { randomUUID } from "node:crypto"

import { and, desc, eq, isNull, sql } from "drizzle-orm"

import { getDb } from "@/db/client"
import { assistants } from "@/db/schema"
import { encryptSecret } from "@/lib/crypto"

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
  /**
   * Whether a secret is set — derived in SQL, so the ciphertext never leaves
   * the database. The UI needs to show *that* one exists; it must never be
   * able to show *what* it is, and a masked value of the real length or a
   * placeholder that round-trips would be the same leak wearing a costume.
   */
  hasServerSecret: sql<boolean>`jsonb_array_length(${assistants.serverSecrets}) > 0`,
} as const

export type AssistantInput = {
  name: string
  voice?: string | null
  accentStyle?: string | null
  instructions?: string | null
  backendInstructions?: string | null
  backendModel?: string | null
  waitingBehavior?: string | null
  serverUrl?: string | null
  /** Plaintext. Encrypted here; never stored or returned as given. */
  serverSecret?: string | null
  tools?: unknown
}

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
  Exclude<keyof typeof publicColumns, "hasServerSecret">
> & { hasServerSecret: boolean }

/** Private source used only to freeze a call's runtime snapshot. */
export type AssistantRuntimeSource = Pick<
  typeof assistants.$inferSelect,
  | "id"
  | "voice"
  | "accentStyle"
  | "instructions"
  | "backendInstructions"
  | "backendModel"
  | "waitingBehavior"
  | "serverUrl"
  | "serverSecrets"
  | "tools"
>

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
  input: AssistantInput
): Promise<Assistant> {
  // An empty string means "no secret given", not "encrypt the empty string".
  // `encryptSecret` refuses an empty plaintext, so without this a form that
  // submits a blank optional field would be a 500 rather than an assistant
  // with no secret.
  const secret =
    input.serverSecret === undefined ||
    input.serverSecret === null ||
    input.serverSecret === ""
      ? null
      : input.serverSecret

  const secrets =
    secret === null
      ? []
      : [{ id: randomUUID(), ciphertext: encryptSecret(secret) }]

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
    .returning(publicColumns)

  return rows[0]!
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
  assistantId: string
): Promise<Assistant | null> {
  const rows = await getDb()
    .select(publicColumns)
    .from(assistants)
    .where(
      and(
        eq(assistants.id, assistantId),
        eq(assistants.accountId, accountId),
        isNull(assistants.archivedAt)
      )
    )
    .limit(1)

  return rows[0] ?? null
}

/**
 * Reads the credential-bearing source for a new call.
 *
 * This projection is deliberately private to the server-side call creation
 * path. Public assistant reads never include `serverSecrets`; the call path
 * needs the ciphertext so it can freeze the exact secret that call will use.
 */
export async function getAssistantRuntimeSourceForAccount(
  accountId: string,
  assistantId: string
): Promise<AssistantRuntimeSource | null> {
  const rows = await getDb()
    .select({
      id: assistants.id,
      voice: assistants.voice,
      accentStyle: assistants.accentStyle,
      instructions: assistants.instructions,
      backendInstructions: assistants.backendInstructions,
      backendModel: assistants.backendModel,
      waitingBehavior: assistants.waitingBehavior,
      serverUrl: assistants.serverUrl,
      serverSecrets: assistants.serverSecrets,
      tools: assistants.tools,
    })
    .from(assistants)
    .where(
      and(
        eq(assistants.id, assistantId),
        eq(assistants.accountId, accountId),
        isNull(assistants.archivedAt)
      )
    )
    .limit(1)

  return rows[0] ?? null
}

/** Every live assistant owned by `accountId`, newest first. */
export async function listAssistantsForAccount(
  accountId: string
): Promise<Assistant[]> {
  return getDb()
    .select(publicColumns)
    .from(assistants)
    .where(
      and(eq(assistants.accountId, accountId), isNull(assistants.archivedAt))
    )
    .orderBy(desc(assistants.createdAt))
}

/**
 * Updates an assistant, scoped to its account. Returns `null` if it is not
 * this account's, so a caller cannot tell "not yours" from "does not exist".
 *
 * **The secret is only touched when a new one is supplied.** An absent or
 * empty `serverSecret` leaves the stored entry exactly as it was — saving an
 * unrelated field must never destroy a customer's credential, and an empty
 * input is "I did not type anything", not "delete it". Clearing is a separate,
 * explicit act (`clearServerSecret`), because destroying a credential should
 * require saying so.
 */
export async function updateAssistantForAccount(
  accountId: string,
  assistantId: string,
  input: AssistantInput & { clearServerSecret?: boolean }
): Promise<Assistant | null> {
  const replacement =
    input.serverSecret === undefined ||
    input.serverSecret === null ||
    input.serverSecret === ""
      ? null
      : input.serverSecret

  const secretChange =
    replacement !== null
      ? {
          serverSecrets: [
            { id: randomUUID(), ciphertext: encryptSecret(replacement) },
          ],
        }
      : input.clearServerSecret === true
        ? { serverSecrets: [] }
        : {}

  const rows = await getDb()
    .update(assistants)
    .set({
      name: input.name,
      voice: input.voice ?? null,
      accentStyle: input.accentStyle ?? null,
      instructions: input.instructions ?? null,
      backendInstructions: input.backendInstructions ?? null,
      backendModel: input.backendModel ?? null,
      waitingBehavior: input.waitingBehavior ?? null,
      serverUrl: input.serverUrl ?? null,
      tools: input.tools ?? [],
      updatedAt: new Date(),
      ...secretChange,
    })
    .where(
      and(
        eq(assistants.id, assistantId),
        eq(assistants.accountId, accountId),
        isNull(assistants.archivedAt)
      )
    )
    .returning(publicColumns)

  return rows[0] ?? null
}

/**
 * Archives an assistant. A soft delete: it leaves the list, but calls that ran
 * against it keep pointing at something real, and it stays unreachable by its
 * own edit URL rather than merely hidden.
 */
export async function archiveAssistantForAccount(
  accountId: string,
  assistantId: string
): Promise<boolean> {
  const rows = await getDb()
    .update(assistants)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(assistants.id, assistantId),
        eq(assistants.accountId, accountId),
        isNull(assistants.archivedAt)
      )
    )
    .returning({ id: assistants.id })

  return rows.length > 0
}
