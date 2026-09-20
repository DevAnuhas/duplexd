import { randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { apiKeys, calls } from '@/db/schema';
import { hashCredential } from '@/lib/credentials';
import { secretsMatch } from '@/lib/crypto';

/**
 * API keys — what a customer's backend actually holds.
 *
 * The whole module is built around one fact: after the single moment a key is
 * displayed, nothing anywhere can reproduce it. Not this process, not the
 * database, not a log. What is stored is a prefix, which is not secret and
 * exists so a key is identifiable in a list and traceable if it turns up in
 * someone's log, and a SHA-256 of the whole key.
 *
 * SHA-256 rather than bcrypt deliberately: the key is 32 bytes of CSPRNG
 * output with no structure to guess, so there is nothing for a slow hash to
 * defend against — and a per-request bcrypt would put ~100 ms on every call
 * start, which is a latency budget the platform does not have.
 */

/** `dk_live_` plus 32 bytes rendered base62. */
const KEY_PREFIX = 'dk_live_';

/** How much of the rendered key is stored in the clear to identify it. */
const PREFIX_LENGTH = KEY_PREFIX.length + 6;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 32 characters drawn uniformly from a 62-character alphabet, via the CSPRNG.
 *
 * `randomBytes`, never `Math.random` — which is seeded, predictable, and has
 * no business near a credential — and never a UUID, which is mostly version
 * and variant bits rather than entropy.
 *
 * **Rejection sampling, not modulo.** 256 is not a multiple of 62, so
 * `byte % 62` makes the first eight symbols 5/4 as likely as the rest. The
 * remaining entropy would still be ample here, which is exactly why it is
 * tempting to leave — but "base62 from a CSPRNG" is read as uniform, and a
 * credential primitive that quietly is not is the kind of thing that gets
 * copied into somewhere the margin is thinner. Bytes at or above the largest
 * multiple of 62 are discarded and redrawn.
 */
function generateKey(): string {
  const LIMIT = Math.floor(256 / BASE62.length) * BASE62.length; // 248
  let rendered = '';

  while (rendered.length < 32) {
    for (const byte of randomBytes(32)) {
      if (byte >= LIMIT) {
        continue;
      }

      rendered += BASE62[byte % BASE62.length];

      if (rendered.length === 32) {
        break;
      }
    }
  }

  return `${KEY_PREFIX}${rendered}`;
}

export type MintedKey = {
  /** The only time this is ever available. It is not stored and cannot be re-derived. */
  raw: string;
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
};

export type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

/**
 * Mints a key for `accountId` and returns it once.
 *
 * The raw key is returned to exactly one caller, which shows it and discards
 * it. It is never written to the row, never logged, and never recoverable
 * afterwards — the row holds only the prefix and the hash.
 */
export async function mintApiKey(
  accountId: string,
  name: string,
  createdBy: string,
): Promise<MintedKey> {
  const raw = generateKey();
  const id = randomUUID();

  const rows = await getDb()
    .insert(apiKeys)
    .values({
      id,
      accountId,
      name,
      prefix: raw.slice(0, PREFIX_LENGTH),
      keyHash: hashCredential(raw),
      createdBy,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
    });

  const row = rows[0]!;

  return { raw, ...row };
}

/** Every key belonging to `accountId`, revoked ones included. Never the key itself. */
export async function listApiKeysForAccount(
  accountId: string,
): Promise<ApiKeySummary[]> {
  return getDb()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, accountId))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Revokes a key, scoped to its account.
 *
 * A soft delete: the row survives so calls made with it stay attributable.
 * `accountId` is in the predicate rather than checked afterwards, so one
 * account cannot revoke another's key by guessing an id.
 */
export async function revokeApiKey(
  accountId: string,
  keyId: string,
): Promise<boolean> {
  const rows = await getDb()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.accountId, accountId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });

  return rows.length > 0;
}

export type DeleteApiKeyResult = 'deleted' | 'has_calls' | 'not_found';

/**
 * Permanently deletes an account's key only when no call points at it.
 *
 * This is intentionally stricter than the database foreign key, which can set
 * `calls.api_key_id` to null. Losing that link would make historical calls
 * look unattributed, so a referenced key must be revoked instead. Locking the
 * key row makes the check and delete one decision: a concurrent call cannot
 * acquire its foreign-key lock between them and erase its own attribution.
 */
export async function deleteApiKey(
  accountId: string,
  keyId: string,
): Promise<DeleteApiKeyResult> {
  return getDb().transaction(async (tx) => {
    const ownedKeys = await tx
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId)))
      .for('update')
      .limit(1);

    if (ownedKeys.length === 0) {
      return 'not_found';
    }

    // Deliberately keyed only by the globally unique key id. A corrupt
    // cross-account call reference must block deletion too; adding accountId
    // here could erase the key and let ON DELETE SET NULL hide that corruption.
    const attributedCalls = await tx
      .select({ id: calls.id })
      .from(calls)
      .where(eq(calls.apiKeyId, keyId))
      .limit(1);

    if (attributedCalls.length > 0) {
      return 'has_calls';
    }

    const deleted = await tx
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId)))
      .returning({ id: apiKeys.id });

    return deleted.length > 0 ? 'deleted' : 'not_found';
  });
}

/**
 * Resolves a raw key to the account that minted it, or `null`.
 *
 * Exported and tested here although nothing calls it until P05, because the
 * shape is what P05 builds against and getting it wrong later is expensive.
 *
 * Three things are deliberate:
 *
 *  1. **The lookup is by prefix, never by the key.** The raw key is never a
 *     bound query parameter, so it cannot reach a log through a failed
 *     statement — the protection is structural rather than a redaction.
 *  2. **The comparison is constant-time**, through the one `secretsMatch` in
 *     `lib/crypto.ts`. `===` on a hash leaks it through timing, one byte at a
 *     time; an attacker with a valid prefix could walk the digest out of the
 *     response latency. There was briefly a second, private copy of this
 *     helper here — two constant-time comparisons is the same smell as two
 *     account resolvers, and the duplicate is gone.
 *  3. **A revoked key returns null.** Revocation is enforced here, not merely
 *     recorded in the row for someone else to notice.
 */
export async function verifyApiKey(
  raw: string,
): Promise<{ accountId: string; keyId: string } | null> {
  if (!raw.startsWith(KEY_PREFIX) || raw.length <= PREFIX_LENGTH) {
    return null;
  }

  const rows = await getDb()
    .select({
      id: apiKeys.id,
      accountId: apiKeys.accountId,
      keyHash: apiKeys.keyHash,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.prefix, raw.slice(0, PREFIX_LENGTH)))
    .limit(1);

  const row = rows[0];

  if (row === undefined || row.revokedAt !== null) {
    return null;
  }

  if (!secretsMatch(row.keyHash, hashCredential(raw))) {
    return null;
  }

  return { accountId: row.accountId, keyId: row.id };
}

/** Best-effort attribution write, debounced to one update per minute. */
export async function markApiKeyUsed(
  keyId: string,
  now = new Date(),
): Promise<void> {
  await getDb()
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiKeys.id, keyId),
        or(
          isNull(apiKeys.lastUsedAt),
          lt(apiKeys.lastUsedAt, new Date(now.getTime() - 60_000)),
        ),
      ),
    );
}
