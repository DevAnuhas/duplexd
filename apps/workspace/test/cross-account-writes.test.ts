import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SignedUpUser } from './helpers/auth.ts';

/**
 * Account scoping on every surface that **writes**, plus the API key surfaces.
 *
 * `test/cross-account-isolation.test.ts` covers the assistant reads. This file
 * covers what P03 adds: update, archive, mint, list and revoke — and it runs
 * them through the server actions as well as the data functions, because the
 * action is the surface a real second account actually reaches.
 *
 * Two rules hold in every test below.
 *
 *  1. **Every isolation assertion is paired with a positive control.** If a
 *     write silently stopped working, every cross-account attempt would return
 *     nothing and this file would pass while proving nothing at all.
 *  2. **Refusal is asserted as post-state, not as a return value.** Not "revoke
 *     returned false" but "the first account's key still verifies". A revoke
 *     that returned false and revoked anyway satisfies the first and fails the
 *     second, and the second is what the customer experiences.
 *
 * Both accounts come from the real Better Auth signup handler, so the account
 * rows and the sessions are the ones the application actually produces.
 */

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders.current,
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => undefined,
}));

const { closeDb } = await import('@/db/client');
const {
  archiveAssistantAction,
  createAssistantAction,
  mintApiKeyAction,
  revokeApiKeyAction,
  updateAssistantAction,
} = await import('@/app/actions');
const {
  archiveAssistantForAccount,
  createAssistant,
  getAssistantForAccount,
  listAssistantsForAccount,
  updateAssistantForAccount,
} = await import('@/data/assistants');
const { listApiKeysForAccount, mintApiKey, revokeApiKey, verifyApiKey } =
  await import('@/data/api-keys');
const { signUpNewAccount } = await import('./helpers/auth.ts');
const { isDatabaseConfigured } = await import('./helpers/environment.ts');

function formDataFor(fields: Record<string, string>): FormData {
  const formData = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }

  return formData;
}

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

afterAll(async () => {
  await closeDb();
});

describeDatabase('two accounts, one another’s assistants', () => {
  let owner: SignedUpUser;
  let intruder: SignedUpUser;
  let ownedId = '';
  let intruderOwnId = '';
  const ownedName = `owned ${randomUUID()}`;

  beforeAll(async () => {
    owner = await signUpNewAccount();
    intruder = await signUpNewAccount();

    const owned = await createAssistant(owner.accountId, {
      name: ownedName,
      instructions: 'Belongs to the owner.',
      serverUrl: 'https://owner.example.invalid/hook',
      serverSecret: `canary-owner-secret-${randomUUID()}`,
    });

    ownedId = String(owned.id);

    const theirs = await createAssistant(intruder.accountId, {
      name: `intruder own ${randomUUID()}`,
      instructions: 'Belongs to the intruder.',
    });

    intruderOwnId = String(theirs.id);
  });

  /** Without this, every assertion below could be passing on an empty database. */
  it('seeded rows each account can read (control)', async () => {
    expect(owner.accountId).not.toBe(intruder.accountId);
    expect(await getAssistantForAccount(owner.accountId, ownedId)).not.toBeNull();
    expect(
      await getAssistantForAccount(intruder.accountId, intruderOwnId),
    ).not.toBeNull();
  });

  describe('through the data functions', () => {
    it('cannot update the owner’s assistant, and does not change it', async () => {
      const before = await getAssistantForAccount(owner.accountId, ownedId);

      expect(
        await updateAssistantForAccount(intruder.accountId, ownedId, {
          name: 'renamed by the intruder',
          instructions: 'Rewritten by the intruder.',
        }),
      ).toBeNull();

      const after = await getAssistantForAccount(owner.accountId, ownedId);

      expect(after?.name).toBe(ownedName);
      expect(after?.instructions).toBe(before?.instructions);
    });

    it('can update its own (control)', async () => {
      const renamed = `intruder renamed ${randomUUID()}`;

      expect(
        await updateAssistantForAccount(intruder.accountId, intruderOwnId, {
          name: renamed,
        }),
      ).not.toBeNull();

      expect(
        (await getAssistantForAccount(intruder.accountId, intruderOwnId))?.name,
      ).toBe(renamed);
    });

    it('cannot archive the owner’s assistant, and it stays readable', async () => {
      expect(await archiveAssistantForAccount(intruder.accountId, ownedId)).toBe(false);

      expect(
        await getAssistantForAccount(owner.accountId, ownedId),
        'the intruder archived the owner’s assistant',
      ).not.toBeNull();
      expect(
        (await listAssistantsForAccount(owner.accountId)).map((row) => String(row.id)),
      ).toContain(ownedId);
    });

    it('lists none of the owner’s assistants', async () => {
      const listed = (await listAssistantsForAccount(intruder.accountId)).map((row) =>
        String(row.id),
      );

      expect(listed).toContain(intruderOwnId);
      expect(listed).not.toContain(ownedId);
    });
  });

  /**
   * The same attempts through the real server actions, acting as the intruder
   * with the intruder's real session cookie. The action resolves the account
   * from that session and from nothing the caller can set, so this is the shape
   * a real cross-account attempt takes.
   */
  describe('through the server actions', () => {
    beforeAll(() => {
      requestHeaders.current = new Headers({ cookie: intruder.cookie });
    });

    it('refuses an edit of the owner’s assistant without a 500, and changes nothing', async () => {
      const result = await updateAssistantAction(
        ownedId,
        formDataFor({ name: 'renamed through the action' }),
      );

      expect(result.ok).toBe(false);

      const after = await getAssistantForAccount(owner.accountId, ownedId);

      expect(after?.name).toBe(ownedName);
    });

    it('reports success for an archive it did not perform, and performs none', async () => {
      // The action reports `ok` because "not yours" and "already gone" are the
      // same answer on purpose — what matters is the post-state, which is that
      // the owner's assistant is untouched.
      await archiveAssistantAction(ownedId);

      expect(
        await getAssistantForAccount(owner.accountId, ownedId),
        'the intruder archived the owner’s assistant through the action',
      ).not.toBeNull();
    });

    it('creates into its own account, never the owner’s (control)', async () => {
      const name = `intruder created ${randomUUID()}`;

      expect(await createAssistantAction(formDataFor({ name }))).toStrictEqual({
        ok: true,
      });

      expect(
        (await listAssistantsForAccount(intruder.accountId)).map((row) => row.name),
      ).toContain(name);
      expect(
        (await listAssistantsForAccount(owner.accountId)).map((row) => row.name),
      ).not.toContain(name);
    });
  });
});

/**
 * API keys. The contract is explicit that key scoping is proved through the
 * list and revoke paths rather than through `verifyApiKey`, which takes only a
 * key and so cannot check a caller's expectation.
 */
describeDatabase('two accounts, one another’s API keys', () => {
  let owner: SignedUpUser;
  let intruder: SignedUpUser;
  let ownerKey: Awaited<ReturnType<typeof mintApiKey>>;
  let intruderKey: Awaited<ReturnType<typeof mintApiKey>>;

  beforeAll(async () => {
    owner = await signUpNewAccount();
    intruder = await signUpNewAccount();

    ownerKey = await mintApiKey(owner.accountId, 'owner key', owner.userId);
    intruderKey = await mintApiKey(intruder.accountId, 'intruder key', intruder.userId);
  });

  it('minted keys that verify to their own accounts (control)', async () => {
    expect(await verifyApiKey(ownerKey.raw)).toStrictEqual({
      accountId: owner.accountId,
      keyId: ownerKey.id,
    });
    expect((await verifyApiKey(intruderKey.raw))?.accountId).toBe(intruder.accountId);
  });

  it('lists only its own keys', async () => {
    const theirs = (await listApiKeysForAccount(intruder.accountId)).map((key) => key.id);
    const ours = (await listApiKeysForAccount(owner.accountId)).map((key) => key.id);

    expect(theirs).toContain(intruderKey.id);
    expect(theirs).not.toContain(ownerKey.id);
    expect(ours).toContain(ownerKey.id);
    expect(ours).not.toContain(intruderKey.id);
  });

  /**
   * The post-state assertion the contract asks for by name: not "revoke
   * returned false" but "the owner's key still verifies".
   */
  it('cannot revoke the owner’s key, which keeps verifying', async () => {
    expect(await revokeApiKey(intruder.accountId, ownerKey.id)).toBe(false);

    expect(
      await verifyApiKey(ownerKey.raw),
      'the intruder revoked the owner’s key',
    ).toStrictEqual({ accountId: owner.accountId, keyId: ownerKey.id });
  });

  it('cannot revoke it through the action either', async () => {
    requestHeaders.current = new Headers({ cookie: intruder.cookie });

    await revokeApiKeyAction(ownerKey.id);

    expect(
      await verifyApiKey(ownerKey.raw),
      'the intruder revoked the owner’s key through the action',
    ).not.toBeNull();
  });

  it('can revoke its own, which stops verifying (control)', async () => {
    expect(await revokeApiKey(intruder.accountId, intruderKey.id)).toBe(true);
    expect(await verifyApiKey(intruderKey.raw)).toBeNull();

    // And the owner's is still alive, so the control did not simply break
    // everything.
    expect(await verifyApiKey(ownerKey.raw)).not.toBeNull();
  });

  it('mints into its own account, never the owner’s', async () => {
    requestHeaders.current = new Headers({ cookie: intruder.cookie });

    const result = await mintApiKeyAction(formDataFor({ name: 'minted by the intruder' }));

    expect(result.ok).toBe(true);

    const raw = result.ok ? result.raw : '';

    expect((await verifyApiKey(raw))?.accountId).toBe(intruder.accountId);
    expect(
      (await listApiKeysForAccount(owner.accountId)).map((key) => key.name),
    ).not.toContain('minted by the intruder');
  });

  /**
   * An empty or unknown account id must not act as a wildcard. A scoping bug
   * that turned `where account_id = ''` into "no predicate" would be invisible
   * to every test above, which always passes a real account.
   */
  it.each([
    ['an empty account id', ''],
    ['an unknown account id', 'no-such-account'],
  ])('returns no keys for %s', async (_label, accountId) => {
    expect(await listApiKeysForAccount(accountId)).toStrictEqual([]);
    expect(await revokeApiKey(accountId, ownerKey.id)).toBe(false);
    expect(await verifyApiKey(ownerKey.raw)).not.toBeNull();
  });
});
