import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb } from '@/db/client';
import {
  deleteApiKey,
  listApiKeysForAccount,
  mintApiKey,
  revokeApiKey,
  verifyApiKey,
} from '@/data/api-keys';

import { withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

/**
 * `deleteApiKey` — the one hard delete in the key lifecycle, and the only place
 * a customer can remove a row rather than tombstone it.
 *
 * Revocation is a soft delete precisely so a call made with a key stays
 * attributable (`test/api-keys.test.ts`). Deletion is the escape hatch for the
 * keys that never got that far: minted by mistake, pasted into the wrong
 * terminal, rotated before anything used them. So the whole contract is one
 * question asked twice — *is this key mine*, and *did anything ever call with
 * it* — and three answers: `deleted`, `has_calls`, `not_found`.
 *
 * Four rules shape every test below.
 *
 *  1. **Refusal is asserted as post-state, not as a return value.** Not
 *     "`deleteApiKey` returned `has_calls`" but "the row is still there and the
 *     call still points at it". A function that returned the refusal and
 *     deleted anyway satisfies the first and fails the second, and the second
 *     is the customer's audit trail.
 *  2. **Deletion is asserted at the row and at the credential.** A `DELETE`
 *     that returned a row id and left the record behind, and one that removed
 *     the record while `verifyApiKey` kept accepting the raw key, are both
 *     "deleted" from the return value's point of view. Both are asserted
 *     against.
 *  3. **Every isolation assertion is paired with a positive control.** The
 *     interesting failure is not "the intruder was refused" — an implementation
 *     that refused *everybody* passes that. It is "the intruder was refused and
 *     then the owner deleted the very same key", which only a working
 *     `account_id` predicate satisfies.
 *  4. **`has_calls` is asserted against the right call.** A key with no calls
 *     of its own must delete even while its account is full of calls belonging
 *     to other keys, and even while unattributed (`api_key_id IS NULL`) calls
 *     exist. Those two are what separate a scoped reference check from "does
 *     this account have any calls at all", which would look identical in the
 *     obvious happy-path test.
 *
 * The `calls` rows are seeded over raw SQL rather than through
 * `insertStartingCall`, for the same reason `test/api-keys.test.ts` seeds its
 * accounts directly: the subject here is the reference check, and routing the
 * fixture through the call-creation path would add an assistant, a rate-limit
 * slot and a token mint that can each fail for reasons that have nothing to do
 * with it. Only the columns the schema actually requires are written, which is
 * also the harshest fixture — `assistant_id` stays null, so nothing but
 * `api_key_id` can be what a correct implementation is keying on.
 */

/** The application's stored prefix length, duplicated so a change here is visible. */
const PREFIX_LENGTH = 'dk_live_'.length + 6;

async function seedAccount(
  label: string,
): Promise<{ accountId: string; userId: string }> {
  const accountId = randomUUID();
  const userId = randomUUID();

  await withTestPool(async (pool) => {
    await pool.query('INSERT INTO accounts (id, name) VALUES ($1, $2)', [
      accountId,
      label,
    ]);
    await pool.query(
      'INSERT INTO users (id, account_id, email, name) VALUES ($1, $2, $3, $4)',
      [userId, accountId, `${userId}@example.invalid`, label],
    );
  });

  return { accountId, userId };
}

/**
 * The minimum valid `calls` row: everything the schema declares `NOT NULL`, and
 * nothing else. `agent_token_hash` is uniquely indexed, so it is derived from a
 * fresh UUID rather than being a literal — a constant would collide the second
 * time this file runs against the same database.
 */
async function seedCall(input: {
  accountId: string;
  apiKeyId: string | null;
  state?: string;
}): Promise<string> {
  const callId = randomUUID();

  await withTestPool(async (pool) => {
    await pool.query(
      `INSERT INTO calls
         (id, account_id, api_key_id, assistant_snapshot, agent_token_hash, state)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        callId,
        input.accountId,
        input.apiKeyId,
        JSON.stringify({ name: 'seeded snapshot', voice: null }),
        createHash('sha256').update(randomUUID()).digest('hex'),
        input.state ?? 'ended',
      ],
    );
  });

  return callId;
}

/** Read over raw SQL: asking the module's own projection whether it deleted a row. */
async function keyRowCount(keyId: string): Promise<number> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ hits: string }>(
      'SELECT count(*)::text AS hits FROM api_keys WHERE id = $1',
      [keyId],
    );

    return Number(rows[0]?.hits ?? 0);
  });
}

/** `undefined` when the call row itself is gone, which is its own failure. */
async function callApiKeyId(callId: string): Promise<string | null | undefined> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ api_key_id: string | null }>(
      'SELECT api_key_id FROM calls WHERE id = $1',
      [callId],
    );

    return rows.length === 0 ? undefined : rows[0]!.api_key_id;
  });
}

async function keyRevokedAt(keyId: string): Promise<string | null | undefined> {
  return withTestPool(async (pool) => {
    const { rows } = await pool.query<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM api_keys WHERE id = $1',
      [keyId],
    );

    return rows.length === 0 ? undefined : rows[0]!.revoked_at;
  });
}

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

afterAll(async () => {
  await closeDb();
});

describeDatabase('deleting a key nothing points at', () => {
  let accountId = '';
  let userId = '';

  beforeAll(async () => {
    ({ accountId, userId } = await seedAccount('api key deletion'));
  });

  /**
   * The whole happy path, asserted at three levels: the return value, the row,
   * and the credential. The control on the first line is what stops this
   * passing against a key that never worked in the first place.
   */
  it('removes the row and stops the raw key verifying', async () => {
    const minted = await mintApiKey(accountId, 'deleted while active', userId);

    expect(
      await verifyApiKey(minted.raw),
      'the key never verified, so "stops verifying" below proves nothing',
    ).toStrictEqual({ accountId, keyId: minted.id });

    expect(await deleteApiKey(accountId, minted.id)).toBe('deleted');

    expect(await keyRowCount(minted.id), 'the row survived a hard delete').toBe(0);
    expect(await verifyApiKey(minted.raw)).toBeNull();
    expect(
      (await listApiKeysForAccount(accountId)).map((key) => key.id),
    ).not.toContain(minted.id);
  });

  /**
   * Revoked keys delete too. This is the case the customer actually hits: they
   * revoke first, see the dead row sitting in the list, and want it gone. An
   * implementation that only deletes live keys — `revoked_at IS NULL` copied
   * across from `revokeApiKey`, which is one plausible line of code away —
   * returns `not_found` here and leaves the row behind.
   */
  it('deletes a revoked key as readily as an active one', async () => {
    const minted = await mintApiKey(accountId, 'deleted while revoked', userId);

    expect(await revokeApiKey(accountId, minted.id)).toBe(true);
    expect(
      await keyRevokedAt(minted.id),
      'the key was not actually revoked, so this is not the case being tested',
    ).not.toBeNull();

    expect(await deleteApiKey(accountId, minted.id)).toBe('deleted');
    expect(await keyRowCount(minted.id)).toBe(0);
    expect(await verifyApiKey(minted.raw)).toBeNull();
  });

  /** A delete scoped to one row. The sibling is the control. */
  it('leaves the account’s other keys alone', async () => {
    const doomed = await mintApiKey(accountId, 'doomed', userId);
    const survivor = await mintApiKey(accountId, 'survivor', userId);

    expect(await deleteApiKey(accountId, doomed.id)).toBe('deleted');

    expect(await keyRowCount(survivor.id)).toBe(1);
    expect(
      await verifyApiKey(survivor.raw),
      'deleting one key took its neighbour with it',
    ).toStrictEqual({ accountId, keyId: survivor.id });
  });

  /**
   * Second delete of the same id. The row is genuinely gone, so this is the
   * unknown-key path arrived at honestly — and it must not report `deleted` for
   * a row it did not delete, which is what a `DELETE` whose result is never
   * inspected would do.
   */
  it('reports not_found when asked again, having already deleted it', async () => {
    const minted = await mintApiKey(accountId, 'deleted twice', userId);

    expect(await deleteApiKey(accountId, minted.id)).toBe('deleted');
    expect(await deleteApiKey(accountId, minted.id)).toBe('not_found');
  });

  it('reports not_found for a key id that does not exist, and deletes nothing', async () => {
    const survivor = await mintApiKey(accountId, 'untouched by a bad id', userId);
    const before = (await listApiKeysForAccount(accountId)).map((key) => key.id).sort();

    expect(await deleteApiKey(accountId, randomUUID())).toBe('not_found');

    expect((await listApiKeysForAccount(accountId)).map((key) => key.id).sort()).toStrictEqual(
      before,
    );
    expect(await verifyApiKey(survivor.raw)).not.toBeNull();
  });

  /**
   * The rate-limit counter is the other table with a foreign key to `api_keys`,
   * and its rows outlive nothing: `consumeCallCreationSlot` writes the counter
   * *before* the call row exists, so a key whose call creation failed has
   * counters and no calls. That key has attributed nothing and must delete —
   * the schema's `ON DELETE CASCADE` is what makes that possible, and without
   * it this is a foreign-key violation rather than a `deleted`.
   */
  it('deletes a key that holds rate-limit counters but attributed no call', async () => {
    const minted = await mintApiKey(accountId, 'counted but never called', userId);

    await withTestPool(async (pool) => {
      await pool.query(
        `INSERT INTO call_rate_limits (api_key_id, window_started_at, count)
         VALUES ($1, now(), $2)`,
        [minted.id, 3],
      );
    });

    expect(await deleteApiKey(accountId, minted.id)).toBe('deleted');
    expect(await keyRowCount(minted.id)).toBe(0);

    const counters = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ hits: string }>(
        'SELECT count(*)::text AS hits FROM call_rate_limits WHERE api_key_id = $1',
        [minted.id],
      );

      return Number(rows[0]?.hits ?? 0);
    });

    expect(counters, 'the counter rows outlived the key they belong to').toBe(0);
  });
});

/**
 * The refusal, and why it is a refusal rather than a cascade.
 *
 * `calls.api_key_id` is nullable with `ON DELETE SET NULL`, so the database
 * would happily accept the delete and quietly null the link. That is precisely
 * the outcome this policy exists to prevent: the call rows survive, so nothing
 * looks broken, but every one of them silently becomes unattributed and the
 * customer's record of which credential placed which call is gone. The key has
 * to be revoked instead.
 *
 * So no test in this block is satisfied by the return value alone. Each one
 * reads the call's `api_key_id` back and asserts it still names the key.
 */
describeDatabase('refusing to delete a key a call points at', () => {
  let accountId = '';
  let userId = '';

  beforeAll(async () => {
    ({ accountId, userId } = await seedAccount('api key deletion with calls'));
  });

  it('keeps the key and the attribution', async () => {
    const minted = await mintApiKey(accountId, 'used by a call', userId);
    const callId = await seedCall({ accountId, apiKeyId: minted.id });

    expect(await deleteApiKey(accountId, minted.id)).toBe('has_calls');

    expect(await keyRowCount(minted.id), 'the referenced key was deleted').toBe(1);
    expect(
      await callApiKeyId(callId),
      'the call lost its attribution, which is the whole point of refusing',
    ).toBe(minted.id);
    expect(await verifyApiKey(minted.raw)).toStrictEqual({
      accountId,
      keyId: minted.id,
    });
  });

  /**
   * The case the contract calls out by name. Revocation and deletion answer
   * different questions — "stop accepting this credential" and "forget this
   * credential ever existed" — and a revoked key that placed calls is still
   * the only record of who placed them.
   */
  it('refuses even when the key is already revoked', async () => {
    const minted = await mintApiKey(accountId, 'revoked and used', userId);
    const callId = await seedCall({ accountId, apiKeyId: minted.id });

    expect(await revokeApiKey(accountId, minted.id)).toBe(true);

    expect(await deleteApiKey(accountId, minted.id)).toBe('has_calls');

    expect(await keyRowCount(minted.id)).toBe(1);
    expect(await keyRevokedAt(minted.id)).not.toBeNull();
    expect(await callApiKeyId(callId)).toBe(minted.id);
  });

  /**
   * The control that stops the block above passing vacuously. If `deleteApiKey`
   * refused everything — a predicate inverted, a transaction that always rolls
   * back — every assertion above would still hold. This is the same account, at
   * the same moment, with calls in its history, deleting a key successfully.
   */
  it('still deletes an unreferenced key of the same account (control)', async () => {
    const used = await mintApiKey(accountId, 'the used one', userId);
    const unused = await mintApiKey(accountId, 'the unused one', userId);
    const callId = await seedCall({ accountId, apiKeyId: used.id });

    expect(await deleteApiKey(accountId, unused.id)).toBe('deleted');
    expect(await keyRowCount(unused.id)).toBe(0);

    // And the reference check is keyed to the key, not to the account: the used
    // key is still refused in the same breath.
    expect(await deleteApiKey(accountId, used.id)).toBe('has_calls');
    expect(await callApiKeyId(callId)).toBe(used.id);
  });

  /**
   * Unattributed calls must not block. `api_key_id` is nullable — a call whose
   * key was already deleted under an older policy, or one the sweeper touched —
   * and a reference check written as "does this account have calls" or one that
   * compares with SQL `=` against a null would refuse here. Both look correct
   * in every other test in this file.
   */
  it('is not blocked by a call that names no key at all', async () => {
    const minted = await mintApiKey(accountId, 'unrelated to the null call', userId);
    const callId = await seedCall({ accountId, apiKeyId: null });

    expect(await callApiKeyId(callId), 'the fixture call is not unattributed').toBeNull();

    expect(await deleteApiKey(accountId, minted.id)).toBe('deleted');
    expect(await keyRowCount(minted.id)).toBe(0);
  });

  /**
   * And a call belonging to a *different* key must not block either. This is
   * the discriminating case for a reference check that forgot its `WHERE`: with
   * one key used and one unused in the same account, an unscoped check refuses
   * both, and only this test notices.
   */
  it('is not blocked by another key’s calls', async () => {
    const noisy = await mintApiKey(accountId, 'the noisy neighbour', userId);
    const quiet = await mintApiKey(accountId, 'the quiet one', userId);

    await seedCall({ accountId, apiKeyId: noisy.id });
    await seedCall({ accountId, apiKeyId: noisy.id, state: 'active' });

    expect(await deleteApiKey(accountId, quiet.id)).toBe('deleted');
    expect(await keyRowCount(quiet.id)).toBe(0);
    expect(await keyRowCount(noisy.id), 'the neighbour was collected too').toBe(1);
  });
});

/**
 * Account scoping, the same shape as `test/cross-account-writes.test.ts`: the
 * owner's key must survive a second account's delete, and the refusal must be
 * "not_found" rather than anything that distinguishes a key that exists from
 * one that does not.
 *
 * The accounts here are seeded directly rather than signed up, because the
 * subject is the data function's predicate. The action-level version of this —
 * a real session, a real cookie — belongs with the other action tests.
 */
describeDatabase('deleting another account’s key', () => {
  let owner = { accountId: '', userId: '' };
  let intruder = { accountId: '', userId: '' };
  let ownerKey: Awaited<ReturnType<typeof mintApiKey>>;

  beforeAll(async () => {
    owner = await seedAccount('key deletion owner');
    intruder = await seedAccount('key deletion intruder');
    ownerKey = await mintApiKey(owner.accountId, 'the owner’s key', owner.userId);
  });

  it('two accounts with keys that verify to themselves (control)', async () => {
    const theirs = await mintApiKey(intruder.accountId, 'the intruder’s own', intruder.userId);

    expect(owner.accountId).not.toBe(intruder.accountId);
    expect(await verifyApiKey(ownerKey.raw)).toStrictEqual({
      accountId: owner.accountId,
      keyId: ownerKey.id,
    });
    expect((await verifyApiKey(theirs.raw))?.accountId).toBe(intruder.accountId);
  });

  it('cannot delete the owner’s key, which stays and keeps verifying', async () => {
    expect(await deleteApiKey(intruder.accountId, ownerKey.id)).toBe('not_found');

    expect(await keyRowCount(ownerKey.id), 'the intruder deleted the owner’s key').toBe(1);
    expect(await verifyApiKey(ownerKey.raw)).toStrictEqual({
      accountId: owner.accountId,
      keyId: ownerKey.id,
    });
    expect(
      (await listApiKeysForAccount(owner.accountId)).map((key) => key.id),
    ).toContain(ownerKey.id);
  });

  /**
   * A referenced key the intruder does not own answers `not_found`, not
   * `has_calls`. Ownership is decided first, so the answer cannot be used to
   * probe whether a guessed key id exists or how busy it has been.
   */
  it('learns nothing about a key it does not own, referenced or not', async () => {
    const referenced = await mintApiKey(owner.accountId, 'owner’s used key', owner.userId);
    const callId = await seedCall({ accountId: owner.accountId, apiKeyId: referenced.id });

    expect(await deleteApiKey(intruder.accountId, referenced.id)).toBe('not_found');

    expect(await keyRowCount(referenced.id)).toBe(1);
    expect(await callApiKeyId(callId)).toBe(referenced.id);

    // The owner, asking about the same key, gets the real answer.
    expect(await deleteApiKey(owner.accountId, referenced.id)).toBe('has_calls');
  });

  /**
   * The control that makes the refusals above mean something: the intruder can
   * delete a key, and the owner can delete the key the intruder could not. An
   * implementation that answered `not_found` to everybody passes every test
   * above and fails this one.
   */
  it('deletes its own key, and the owner deletes the one it could not (control)', async () => {
    const theirs = await mintApiKey(intruder.accountId, 'the intruder’s doomed key', intruder.userId);

    expect(await deleteApiKey(intruder.accountId, theirs.id)).toBe('deleted');
    expect(await keyRowCount(theirs.id)).toBe(0);

    expect(
      await deleteApiKey(owner.accountId, ownerKey.id),
      'the owner could not delete an unreferenced key of its own',
    ).toBe('deleted');
    expect(await keyRowCount(ownerKey.id)).toBe(0);
    expect(await verifyApiKey(ownerKey.raw)).toBeNull();
  });

  /**
   * An empty or unknown account id must not act as a wildcard. A predicate that
   * collapsed to "no predicate" would be invisible to every test above, which
   * always passes a real account id.
   */
  it.each([
    ['an empty account id', ''],
    ['an unknown account id', 'no-such-account'],
  ])('deletes nothing for %s', async (_label, accountId) => {
    const key = await mintApiKey(owner.accountId, `bystander ${randomUUID()}`, owner.userId);

    expect(await deleteApiKey(accountId, key.id)).toBe('not_found');

    expect(await keyRowCount(key.id)).toBe(1);
    expect(await verifyApiKey(key.raw)).toStrictEqual({
      accountId: owner.accountId,
      keyId: key.id,
    });
    expect(key.prefix).toBe(key.raw.slice(0, PREFIX_LENGTH));
  });
});
