import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * API keys as credentials: minting, verification, and revocation.
 *
 * Three things here are asserted at the source rather than at the output,
 * because the output of a broken implementation looks identical to the output
 * of a correct one.
 *
 *  - **Entropy.** A key made from `Math.random`, a UUID, or a timestamp is the
 *    same length and the same shape as one made from 32 CSPRNG bytes. So the
 *    assertion is that `randomBytes(32)` is called *and that its output is what
 *    the key is made of* — stubbed to a known value, the rendered key must be
 *    the known mapping of those bytes.
 *  - **Constant-time comparison.** It cannot be observed by timing; a stopwatch
 *    assertion would be flaky and would prove nothing either way. So a spy
 *    asserts `timingSafeEqual` is called with the two digests. Replace the
 *    comparison with `===` and this file goes red.
 *  - **Revocation.** Asserted through `verifyApiKey` after the revoke, never by
 *    reading `revoked_at`. A row recording a revocation that nothing enforces
 *    is worse than no revocation, because the customer believes the key is
 *    dead.
 *
 * `node:crypto` is mocked, and only as a pass-through: every function is the
 * real one, two of them wrapped in a spy. Nothing here changes what the code
 * computes.
 */

const cryptoMock = vi.hoisted(() => ({
  randomBytes: vi.fn(),
  timingSafeEqual: vi.fn(),
  /** When set, the next 32-byte request gets this instead. Consumed once. */
  nextKeyBytes: null as Buffer | null,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();

  cryptoMock.randomBytes.mockImplementation((...args: unknown[]) => {
    if (args.length === 1 && args[0] === 32 && cryptoMock.nextKeyBytes !== null) {
      const stubbed = cryptoMock.nextKeyBytes;
      cryptoMock.nextKeyBytes = null;

      return stubbed;
    }

    return (actual.randomBytes as (...a: unknown[]) => unknown)(...args);
  });

  cryptoMock.timingSafeEqual.mockImplementation((a: unknown, b: unknown) =>
    actual.timingSafeEqual(a as NodeJS.ArrayBufferView, b as NodeJS.ArrayBufferView),
  );

  return {
    ...actual,
    default: actual,
    randomBytes: cryptoMock.randomBytes,
    timingSafeEqual: cryptoMock.timingSafeEqual,
  };
});

const { closeDb } = await import('@/db/client');
const { listApiKeysForAccount, mintApiKey, revokeApiKey, verifyApiKey } =
  await import('@/data/api-keys');
const { withTestPool } = await import('./helpers/database.ts');
const { isDatabaseConfigured } = await import('./helpers/environment.ts');

/** The rendered alphabet, duplicated here so the expected mapping is independent. */
const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const KEY_PREFIX = 'dk_live_';
/** `dk_live_` plus six rendered characters, matching the module's stored prefix. */
const PREFIX_LENGTH = KEY_PREFIX.length + 6;

/**
 * The largest multiple of 62 that fits in a byte. Bytes at or above it are
 * discarded and redrawn, which is what keeps the alphabet uniform.
 */
const REJECTION_LIMIT = Math.floor(256 / BASE62.length) * BASE62.length;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Replaces one character of the key body, keeping the prefix and the length. */
function tamperBody(raw: string): string {
  const index = raw.length - 1;
  const current = raw[index] ?? '0';
  const replacement = current === 'a' ? 'b' : 'a';

  return `${raw.slice(0, index)}${replacement}`;
}

/**
 * An account and a user, inserted directly.
 *
 * Signup is deliberately not used here. The subject of this file is the key
 * mechanism, and Better Auth's signup would add a second thing that could fail
 * and a second reason a spy assertion could see calls it did not make. The real
 * signup path is where cross-account isolation is proved, in
 * `test/cross-account-writes.test.ts`.
 */
async function seedAccount(label: string): Promise<{ accountId: string; userId: string }> {
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

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

afterAll(async () => {
  await closeDb();
});

describeDatabase('minting a key', () => {
  let accountId = '';
  let userId = '';

  beforeAll(async () => {
    ({ accountId, userId } = await seedAccount('api key mechanics'));

    // Opens the pool before any test measures a spy, so a connection handshake
    // cannot land inside a call-count assertion.
    await listApiKeysForAccount(accountId);
  });

  it('renders dk_live_ followed by base62', async () => {
    const minted = await mintApiKey(accountId, 'shape', userId);

    expect(minted.raw.startsWith(KEY_PREFIX)).toBe(true);
    expect(minted.raw.slice(KEY_PREFIX.length)).toMatch(/^[0-9A-Za-z]+$/);
    expect(minted.prefix).toBe(minted.raw.slice(0, PREFIX_LENGTH));
  });

  /**
   * Entropy at the source. The length of the rendered key says nothing — a
   * `Math.random` loop produces exactly the same shape.
   */
  it('takes 32 bytes from the CSPRNG and no bytes from Math.random', async () => {
    const mathRandom = vi.spyOn(Math, 'random');
    cryptoMock.randomBytes.mockClear();

    try {
      await mintApiKey(accountId, 'entropy at the source', userId);
    } finally {
      mathRandom.mockRestore();
    }

    const sizes = cryptoMock.randomBytes.mock.calls.map((call) => call[0]);

    expect(sizes, 'randomBytes(32) was never called while minting').toContain(32);
    expect(mathRandom, 'Math.random has no business near a credential').not.toHaveBeenCalled();
  });

  /**
   * The half that a call-count assertion misses: `randomBytes(32)` can be
   * called and its result thrown away. Stubbing it to a known value and
   * asserting the rendered key is the known mapping proves the key is actually
   * made of those bytes.
   */
  it('renders the key from exactly those CSPRNG bytes', async () => {
    // Unique per run rather than a fixed literal. A constant would render a
    // constant key, whose prefix collides with the unique index the second time
    // this file runs against the same database — and the subject here is the
    // mapping from bytes to key, which a fresh 32 bytes tests just as well.
    //
    // Every byte is brought below the rejection limit so a single draw yields
    // all 32 characters. With a byte at or above it the generator would draw
    // again and the expected value would depend on the real CSPRNG.
    const bytes = Buffer.from(
      [...createHash('sha256').update(randomUUID()).digest()].map(
        (byte) => byte % REJECTION_LIMIT,
      ),
    );
    const expected =
      KEY_PREFIX +
      [...bytes].map((byte) => BASE62[byte % BASE62.length]).join('');

    cryptoMock.nextKeyBytes = bytes;

    const minted = await mintApiKey(accountId, 'derived from the bytes', userId);

    expect(cryptoMock.nextKeyBytes, 'the stub was never consumed').toBeNull();
    expect(minted.raw).toBe(expected);
    expect(minted.raw).toHaveLength(KEY_PREFIX.length + 32);
  });

  /**
   * Uniformity, which plain `byte % 62` does not give: 256 is not a multiple of
   * 62, so the first eight symbols would come up 5/4 as often as the rest.
   *
   * Asserted by feeding a whole draw of bytes that are *only* rejectable. Under
   * rejection sampling every one is discarded and the generator draws again, so
   * the key is ordinary. Under modulo, 248 through 255 fold onto `0` through
   * `7` and the key would be made entirely of those eight characters — which is
   * what this asserts it is not.
   */
  it('discards bytes above the rejection limit rather than folding them', async () => {
    cryptoMock.nextKeyBytes = Buffer.alloc(32, REJECTION_LIMIT);

    const minted = await mintApiKey(accountId, 'rejection sampling', userId);
    const body = minted.raw.slice(KEY_PREFIX.length);

    expect(cryptoMock.nextKeyBytes, 'the stub was never consumed').toBeNull();
    expect(body).toHaveLength(32);
    expect(
      body,
      'every rejectable byte was folded into the first eight symbols',
    ).not.toMatch(/^[0-7]{32}$/);
  });

  it('never mints the same key twice', async () => {
    const minted = await Promise.all([
      mintApiKey(accountId, 'first', userId),
      mintApiKey(accountId, 'second', userId),
      mintApiKey(accountId, 'third', userId),
    ]);

    const raws = minted.map((key) => key.raw);

    expect(new Set(raws).size).toBe(raws.length);
    expect(new Set(minted.map((key) => key.prefix)).size).toBe(raws.length);
  });

  /**
   * The stored row, read over raw SQL rather than through the module's own
   * projection: asking the projection whether it leaks is asking the fox about
   * the henhouse.
   */
  it('stores a prefix and a SHA-256, and no column holds the key', async () => {
    const minted = await mintApiKey(accountId, 'stored shape', userId);

    const row = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(k) AS row FROM api_keys k WHERE k.id = $1',
        [minted.id],
      );

      return rows[0]?.row;
    });

    expect(row, 'the key row was not written').toBeDefined();
    expect(row?.prefix).toBe(minted.raw.slice(0, PREFIX_LENGTH));
    expect(row?.key_hash).toBe(sha256Hex(minted.raw));

    for (const [column, value] of Object.entries(row ?? {})) {
      expect(
        JSON.stringify(value ?? null),
        `column ${column} contains the raw key`,
      ).not.toContain(minted.raw);
    }
  });

  /**
   * The whole-database sweep, the same shape as the secret canary sweep. The
   * check above only looks at `api_keys`; this asks every table whether the key
   * landed anywhere a later change might have copied it.
   */
  it('has the raw key in no row of any table', async () => {
    const minted = await mintApiKey(accountId, 'canary key', userId);

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
          [`%${minted.raw}%`],
        );

        if (Number(rows[0]?.hits ?? 0) > 0) {
          found.push(table_name);
        }
      }

      return found;
    });

    expect(hits).toStrictEqual([]);
  });

  /** Everything the list is allowed to say about a key. Exact, so a new column fails closed. */
  it('lists keys without the key or its hash', async () => {
    const minted = await mintApiKey(accountId, 'listed', userId);
    const listed = await listApiKeysForAccount(accountId);
    const row = listed.find((entry) => entry.id === minted.id);

    expect(row, 'the minted key is missing from its own account’s list').toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toStrictEqual([
      'createdAt',
      'id',
      'lastUsedAt',
      'name',
      'prefix',
      'revokedAt',
    ]);
    expect(JSON.stringify(listed)).not.toContain(minted.raw);
    expect(JSON.stringify(listed)).not.toContain(sha256Hex(minted.raw));
  });
});

describeDatabase('verifying a key', () => {
  let accountId = '';
  let userId = '';
  let minted: Awaited<ReturnType<typeof mintApiKey>>;

  beforeAll(async () => {
    ({ accountId, userId } = await seedAccount('api key verification'));

    minted = await mintApiKey(accountId, 'the good key', userId);
  });

  it('accepts a valid key and returns its minting account', async () => {
    expect(await verifyApiKey(minted.raw)).toStrictEqual({
      accountId,
      keyId: minted.id,
    });
  });

  /**
   * The case that matters. Same prefix, so the indexed read *finds the row*;
   * same length, so nothing can be passing on a length check; one character
   * different, so only the digest comparison can reject it.
   */
  it('rejects a wrong key of the same length whose prefix exists', async () => {
    const wrong = tamperBody(minted.raw);

    expect(wrong).toHaveLength(minted.raw.length);
    expect(wrong.slice(0, PREFIX_LENGTH)).toBe(minted.raw.slice(0, PREFIX_LENGTH));
    expect(wrong).not.toBe(minted.raw);

    expect(await verifyApiKey(wrong)).toBeNull();
  });

  it('rejects a wrong key of the same length whose prefix does not exist', async () => {
    const other = await mintApiKey(accountId, 'a different key', userId);

    expect(other.raw).toHaveLength(minted.raw.length);
    expect(await verifyApiKey(`${other.raw.slice(0, PREFIX_LENGTH)}${minted.raw.slice(PREFIX_LENGTH)}`)).toBeNull();
  });

  it.each([
    ['the empty string', ''],
    ['the prefix alone', KEY_PREFIX],
    ['a key with the wrong scheme', 'dk_test_0000000000000000000000000000000000000'],
    ['something that is not a key at all', 'not-a-key'],
    ['a bare hash', sha256Hex('anything')],
  ])('rejects %s', async (_label, candidate) => {
    expect(await verifyApiKey(candidate)).toBeNull();
  });

  /**
   * The structural half of the constant-time proof. Not "a function named
   * something reassuring was called" — the assertion is that `timingSafeEqual`
   * received the two SHA-256 digests. Replacing the comparison with `===`
   * leaves the spy uncalled and fails this.
   */
  it('compares the digests with timingSafeEqual', async () => {
    cryptoMock.timingSafeEqual.mockClear();

    expect(await verifyApiKey(minted.raw)).not.toBeNull();

    const digest = sha256Hex(minted.raw);
    const comparisons = cryptoMock.timingSafeEqual.mock.calls.map((call) =>
      call.map((argument) => Buffer.from(argument as Uint8Array).toString('utf8')),
    );

    expect(
      comparisons,
      'verifyApiKey did not compare the digests with timingSafeEqual',
    ).toContainEqual([digest, digest]);
  });

  it('compares with timingSafeEqual on the rejection path too', async () => {
    cryptoMock.timingSafeEqual.mockClear();

    expect(await verifyApiKey(tamperBody(minted.raw))).toBeNull();

    const stored = sha256Hex(minted.raw);
    const comparisons = cryptoMock.timingSafeEqual.mock.calls.map((call) =>
      call.map((argument) => Buffer.from(argument as Uint8Array).toString('utf8')),
    );

    expect(
      comparisons.some(([left, right]) => left === stored && right !== stored),
      'a near-miss key was rejected without a constant-time comparison',
    ).toBe(true);
  });

  it('never returns another account’s id for a key it did not mint', async () => {
    const other = await seedAccount('a second minting account');
    const theirs = await mintApiKey(other.accountId, 'theirs', other.userId);

    expect((await verifyApiKey(theirs.raw))?.accountId).toBe(other.accountId);
    expect((await verifyApiKey(minted.raw))?.accountId).toBe(accountId);
  });
});

/**
 * Revocation, asserted as enforcement rather than as a record.
 *
 * The sequence is the contract's: mint, verify accepts, revoke, verify now
 * fails. Not one assertion here reads `revoked_at` to decide whether revocation
 * worked — a column saying a key is dead while `verifyApiKey` still accepts it
 * is the precise failure this is written to catch.
 */
describeDatabase('revoking a key', () => {
  let accountId = '';
  let userId = '';

  beforeAll(async () => {
    ({ accountId, userId } = await seedAccount('api key revocation'));
  });

  it('makes a key that verified stop verifying', async () => {
    const minted = await mintApiKey(accountId, 'to be revoked', userId);

    expect(
      await verifyApiKey(minted.raw),
      'the key did not verify before revocation, so the test below proves nothing',
    ).toStrictEqual({ accountId, keyId: minted.id });

    expect(await revokeApiKey(accountId, minted.id)).toBe(true);

    expect(await verifyApiKey(minted.raw)).toBeNull();
  });

  it('leaves other keys of the same account verifying', async () => {
    const doomed = await mintApiKey(accountId, 'doomed', userId);
    const survivor = await mintApiKey(accountId, 'survivor', userId);

    await revokeApiKey(accountId, doomed.id);

    expect(await verifyApiKey(doomed.raw)).toBeNull();
    expect(await verifyApiKey(survivor.raw)).not.toBeNull();
  });

  /** Soft delete: the row survives so calls made with the key stay attributable. */
  it('keeps the row, so a revoked key’s calls stay attributable', async () => {
    const minted = await mintApiKey(accountId, 'soft deleted', userId);

    await revokeApiKey(accountId, minted.id);

    const row = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ id: string; prefix: string; revoked_at: string | null }>(
        'SELECT id, prefix, revoked_at FROM api_keys WHERE id = $1',
        [minted.id],
      );

      return rows[0];
    });

    expect(row?.id).toBe(minted.id);
    expect(row?.prefix).toBe(minted.prefix);
    expect(row?.revoked_at).not.toBeNull();

    expect(
      (await listApiKeysForAccount(accountId)).map((key) => key.id),
    ).toContain(minted.id);
  });

  it('is idempotent, and the key stays rejected', async () => {
    const minted = await mintApiKey(accountId, 'revoked twice', userId);

    expect(await revokeApiKey(accountId, minted.id)).toBe(true);
    expect(await revokeApiKey(accountId, minted.id)).toBe(false);
    expect(await verifyApiKey(minted.raw)).toBeNull();
  });

  it('reports false for a key id that does not exist, and changes nothing', async () => {
    const survivor = await mintApiKey(accountId, 'untouched', userId);

    expect(await revokeApiKey(accountId, randomUUID())).toBe(false);
    expect(await verifyApiKey(survivor.raw)).not.toBeNull();
  });
});
