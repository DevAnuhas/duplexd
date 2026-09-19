import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { apiKeys } from '@/db/schema';

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

const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 32 bytes from the CSPRNG, rendered base62.
 *
 * `randomBytes`, never `Math.random` — which is seeded, predictable, and has
 * no business anywhere near a credential — and never a UUID, which is mostly
 * version and variant bits rather than entropy.
 *
 * Bytes are mapped by rejection-free modulo over a 62-character alphabet. The
 * slight bias that introduces is irrelevant against 256 bits of input; what
 * matters is that every byte comes from the CSPRNG.
 */
function generateKey(): string {
  const bytes = randomBytes(32);
  let rendered = '';

  for (const byte of bytes) {
    rendered += BASE62[byte % BASE62.length];
  }

  return `${KEY_PREFIX}${rendered}`;
}

/** SHA-256 of the whole key, hex. The only form that is ever persisted. */
function hashKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
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
      keyHash: hashKey(raw),
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
 *  2. **The comparison is constant-time.** `===` on a hash leaks it through
 *     timing, one byte at a time; an attacker with a valid prefix could walk
 *     the digest out of the response latency.
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

  if (!hashesMatch(row.keyHash, hashKey(raw))) {
    return null;
  }

  return { accountId: row.accountId, keyId: row.id };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch.
 * Both inputs are SHA-256 hex here, so a length difference means malformed
 * input rather than a near-miss guess, and leaks nothing.
 */
function hashesMatch(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(candidate, 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}
