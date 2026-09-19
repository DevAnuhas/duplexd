import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb } from '@/db/client';
import {
  createAssistant,
  getAssistantForAccount,
  listAssistantsForAccount,
} from '@/data/assistants';
import { decryptSecret } from '@/lib/crypto';

import { signUpNewAccount, type SignedUpUser } from './helpers/auth.ts';
import { withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

/**
 * The customer's webhook secret, followed from the create call to the row.
 *
 * The secret belongs to the customer and the platform is only holding it. This
 * file asks the only question that matters about that: after the real create
 * function has run, can the plaintext be found anywhere — in any column of any
 * table, or in anything a read path hands back?
 *
 * The stored-row assertions read over raw SQL rather than through the Drizzle
 * projection. Reading through `publicColumns` would be circular: that projection
 * is the thing under test, and asking it whether it leaks is asking the fox
 * about the henhouse.
 *
 * One pool for the whole file, closed once at the end. `closeDb()` in a
 * per-describe hook would tear down the pool Better Auth captured when it was
 * constructed, and every later signup in the file would fail on a dead pool.
 */

/**
 * Unique per run, and that matters.
 *
 * The sweep below asks every table in the database whether the canary appears
 * anywhere. With a fixed string, one run that genuinely leaked — a broken build,
 * somebody's mutation experiment — would leave a plaintext row behind and every
 * later run would stay red for a leak that no longer exists. A per-run value
 * keeps the sweep's breadth while making its answer about this run only.
 */
const CANARY = `canary-server-secret-${randomUUID()}`;

type SecretEntry = { id: string; ciphertext: string };

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

afterAll(async () => {
  await closeDb();
});

describeDatabase('a secret written through createAssistant', () => {
  let account: SignedUpUser;
  let assistantId = '';
  let created: Record<string, unknown>;

  beforeAll(async () => {
    account = await signUpNewAccount();

    created = (await createAssistant(account.accountId, {
      name: 'Secret-bearing assistant',
      serverUrl: 'https://hooks.example.invalid/inbound',
      serverSecret: CANARY,
      instructions: 'Has a server secret.',
    })) as Record<string, unknown>;

    assistantId = String(created.id);
  });

  /** Every column of the stored row, so nothing is inspected selectively. */
  async function storedRow(): Promise<Record<string, unknown>> {
    return withTestPool(async (pool) => {
      const { rows } = await pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(a) AS row FROM assistants a WHERE a.id = $1',
        [assistantId],
      );

      const raw = rows[0]?.row;

      expect(raw, 'the assistant row was not written').toBeDefined();

      return raw ?? {};
    });
  }

  it('wrote a row', async () => {
    expect(assistantId).not.toBe('');
    expect(Object.keys(await storedRow()).length).toBeGreaterThan(0);
  });

  it('has no column containing the plaintext', async () => {
    const row = await storedRow();

    for (const [column, value] of Object.entries(row)) {
      expect(
        JSON.stringify(value ?? null),
        `column ${column} contains the plaintext secret`,
      ).not.toContain(CANARY);
    }
  });

  /**
   * The whole-database sweep. The check above only looks at `assistants`; this
   * asks every table in `public` whether the canary landed anywhere, which
   * catches a leak into `calls.assistant_snapshot`, an audit row, or anywhere
   * else a later change might copy it.
   *
   * `to_jsonb(t)::text` renders the entire row, so no column can be missed by
   * having an unexpected type.
   */
  it('has the plaintext in no row of any table', async () => {
    const hits = await withTestPool(async (pool) => {
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );

      const found: string[] = [];

      for (const { table_name } of tables) {
        const { rows } = await pool.query<{ hits: string }>(
          `SELECT count(*)::text AS hits FROM "${table_name}" t
           WHERE to_jsonb(t)::text LIKE $1`,
          [`%${CANARY}%`],
        );

        if (Number(rows[0]?.hits ?? 0) > 0) {
          found.push(table_name);
        }
      }

      return found;
    });

    expect(hits).toStrictEqual([]);
  });

  /**
   * The JSON list shape. `server_secrets` is a list from the start so rotation
   * is later an append rather than a migration of every row; a scalar column
   * would pass an "is it encrypted" test and still make rotation a schema
   * change.
   */
  it('stores server_secrets as a JSON list of ciphertext entries', async () => {
    const secrets = (await storedRow()).server_secrets as SecretEntry[];

    expect(Array.isArray(secrets)).toBe(true);
    expect(secrets).toHaveLength(1);

    const [entry] = secrets;

    expect(typeof entry?.id).toBe('string');
    expect(entry?.id).not.toBe('');
    expect(typeof entry?.ciphertext).toBe('string');
    expect(entry?.ciphertext).not.toContain(CANARY);
    expect(entry?.ciphertext).toMatch(/^v1\./);
  });

  it('stores ciphertext that decrypts back to the original secret', async () => {
    const secrets = (await storedRow()).server_secrets as SecretEntry[];

    expect(decryptSecret(secrets[0]?.ciphertext ?? '')).toBe(CANARY);
  });

  it('gives two assistants with the same secret different ciphertext', async () => {
    const other = await createAssistant(account.accountId, {
      name: 'Another assistant, same secret',
      serverSecret: CANARY,
    });

    const both = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ server_secrets: SecretEntry[] }>(
        'SELECT server_secrets FROM assistants WHERE id = ANY($1::text[])',
        [[assistantId, String(other.id)]],
      );

      return rows.map((row) => row.server_secrets[0]?.ciphertext ?? '');
    });

    expect(both).toHaveLength(2);
    expect(both[0]).not.toBe('');
    expect(both[0]).not.toBe(both[1]);
  });

  it('stores an empty list when no secret is given', async () => {
    const withoutSecret = await createAssistant(account.accountId, {
      name: 'No secret at all',
    });

    const secrets = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ server_secrets: SecretEntry[] }>(
        'SELECT server_secrets FROM assistants WHERE id = $1',
        [String(withoutSecret.id)],
      );

      return rows[0]?.server_secrets;
    });

    expect(secrets).toStrictEqual([]);
  });

  /**
   * What the read paths hand back.
   *
   * The rule the contract binds now, before P03 builds an edit form on top: a
   * read path serving a secret-bearing row **enumerates its columns and excludes
   * the secret**, rather than selecting everything and omitting it later.
   * Enumeration fails closed when the schema grows; an omission list silently
   * starts leaking the moment somebody adds a column.
   *
   * These assert the absence of the *field*, not merely the absence of the
   * plaintext. A field holding ciphertext would satisfy "no plaintext here" and
   * still hand every caller the material to attack offline.
   */
  describe('read paths', () => {
    /**
     * Any key that could plausibly carry secret material.
     *
     * `hasServerSecret` is the one exception, and it is excluded **by exact
     * name** rather than by loosening the pattern. P03 added it to the
     * projection: the UI has to show *that* a secret is set, so a boolean
     * derived in SQL is exactly right — and it trips this sweep on the word
     * "secret", which is the sweep working rather than failing.
     *
     * Dropping `secret` from the pattern would have been the quicker fix and
     * would have let the next field actually called `serverSecret` straight
     * through. An exact-name allowance cannot do that, and the test below
     * asserts this particular field really is a boolean before allowing it, so
     * a column that smuggled the ciphertext under the same name would still
     * fail.
     */
    function secretishKeys(value: Record<string, unknown>): string[] {
      const allowed = new Set(['hasServerSecret']);

      return Object.keys(value).filter(
        (key) => !allowed.has(key) && /secret|cipher|password|token|key/i.test(key),
      );
    }

    /**
     * The allowance above is only safe while this holds: a boolean, never a
     * masked value of the real length and never a placeholder that round-trips
     * as if it were the secret.
     */
    it('exposes hasServerSecret as a boolean and nothing more', async () => {
      const row = await getAssistantForAccount(account.accountId, assistantId);

      expect(typeof row?.hasServerSecret).toBe('boolean');
      expect(row?.hasServerSecret).toBe(true);
      expect(String(row?.hasServerSecret)).not.toContain(CANARY);
    });

    it('createAssistant returns no secret field and no plaintext', () => {
      expect(secretishKeys(created)).toStrictEqual([]);
      expect(created).not.toHaveProperty('serverSecrets');
      expect(created).not.toHaveProperty('server_secrets');
      expect(created).not.toHaveProperty('serverSecret');
      expect(JSON.stringify(created)).not.toContain(CANARY);
    });

    it('getAssistantForAccount returns no secret field and no plaintext', async () => {
      const row = (await getAssistantForAccount(
        account.accountId,
        assistantId,
      )) as Record<string, unknown> | null;

      expect(row).not.toBeNull();
      expect(secretishKeys(row ?? {})).toStrictEqual([]);
      expect(row).not.toHaveProperty('serverSecrets');
      expect(JSON.stringify(row)).not.toContain(CANARY);
    });

    it('listAssistantsForAccount returns no secret field and no plaintext', async () => {
      const rows = (await listAssistantsForAccount(
        account.accountId,
      )) as unknown as Record<string, unknown>[];

      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        expect(secretishKeys(row)).toStrictEqual([]);
        expect(row).not.toHaveProperty('serverSecrets');
      }

      expect(JSON.stringify(rows)).not.toContain(CANARY);
    });

    /**
     * The projection is the mechanism, so it is asserted directly: every read
     * path returns exactly the same key set. A new read path that quietly
     * returned one extra column would otherwise only be caught if somebody
     * thought to add it to the list above.
     */
    it('returns an identical column set from every read path', async () => {
      const single = (await getAssistantForAccount(
        account.accountId,
        assistantId,
      )) as Record<string, unknown> | null;
      const listed = (await listAssistantsForAccount(
        account.accountId,
      )) as unknown as Record<string, unknown>[];

      const fromCreate = Object.keys(created).sort();

      expect(fromCreate.length).toBeGreaterThan(0);
      expect(Object.keys(single ?? {}).sort()).toStrictEqual(fromCreate);

      for (const row of listed) {
        expect(Object.keys(row).sort()).toStrictEqual(fromCreate);
      }
    });
  });
});
