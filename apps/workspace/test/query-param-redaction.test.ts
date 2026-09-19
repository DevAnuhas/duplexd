import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb } from '@/db/client';
import { createAssistant } from '@/data/assistants';
import { withRedactedQueryErrors } from '@/db/redact';
import { assistants } from '@/db/schema';

import { openTestPool, withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

/**
 * Bound query parameters must not reach a log when a query fails.
 *
 * Drizzle builds `DrizzleQueryError`'s message as
 * `` `Failed query: ${query}\nparams: ${params}` ``, so a failing insert
 * carries its bound values into whatever catches it. For this schema that is
 * the ciphertext of a customer's webhook secret today, and from P05 it is
 * `call_events` payloads carrying transcripts, which `docs/OPERATIONS.md`
 * forbids logging in full.
 *
 * **Every assertion here runs a real failing query with a planted canary, and
 * none of them asserts on the message format.** That is the whole design. If
 * this file checked that the redaction's regex matched some expected string, a
 * Drizzle upgrade that changed the format would leave the regex matching
 * nothing and the test still green — the redaction would quietly stop working
 * and nobody would be told. Instead the unwrapped client must *leak* the
 * canary and the wrapped one must not. If the format moves, the first half
 * stops leaking and this file goes red, loudly, which is the point.
 */

/** Unique per run, so a leak from an earlier run cannot keep this one red. */
const CANARY = `canary-param-${randomUUID()}`;

/** Ciphertext-shaped, because ciphertext in a log is what item 22a is about. */
const CIPHERTEXT_CANARY = `v1.${CANARY}`;

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

/**
 * Everything an error could carry a value in: the message, the stack, and every
 * error in the `cause` chain. A redaction that cleaned the message and left the
 * stack would pass a message-only check while `console.error(err)` — which
 * prints the stack — leaked the lot.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    parts.push(current.message, String(current.stack ?? ''));
    current = current.cause;
  }

  if (current !== undefined && current !== null && !(current instanceof Error)) {
    parts.push(String(current));
  }

  return parts.join('\n');
}

/** Runs `body`, returning the error it threw. Fails loudly if it did not throw. */
async function captureFailure(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error) {
    return error;
  }

  throw new Error(
    'The query was expected to fail and did not, so nothing was captured and ' +
      'every assertion below would be vacuous.',
  );
}

describeDatabase('a failing query', () => {
  let unwrappedFailure: unknown;
  let wrappedFailure: unknown;
  let pool: ReturnType<typeof openTestPool>;

  beforeAll(async () => {
    pool = openTestPool();

    // Two clients over one pool, differing only in the wrapper. The failure is
    // a foreign key violation on `account_id`, which happens in the database
    // after the values have been bound — so the parameters are genuinely in
    // front of the driver, which an unroutable host or a killed connection
    // would not achieve.
    const unwrapped = drizzle(pool);
    const wrapped = withRedactedQueryErrors(drizzle(pool));

    const values = () => ({
      id: randomUUID(),
      accountId: 'no-such-account-forcing-a-constraint-failure',
      name: CANARY,
      serverSecrets: [{ id: randomUUID(), ciphertext: CIPHERTEXT_CANARY }],
    });

    unwrappedFailure = await captureFailure(() =>
      unwrapped.insert(assistants).values(values()),
    );
    wrappedFailure = await captureFailure(() =>
      wrapped.insert(assistants).values(values()),
    );
  });

  afterAll(async () => {
    await pool.end();
    await closeDb();
  });

  /**
   * The half that makes the other half meaningful. If Drizzle stops putting
   * parameters in the message, this fails and the file says so, rather than the
   * redaction silently becoming a no-op that still reports green.
   */
  it('leaks its bound parameters through an unwrapped client', () => {
    const text = errorText(unwrappedFailure);

    expect(
      text,
      'an unwrapped client no longer leaks parameters — either Drizzle changed ' +
        'its message format or this is no longer a real failing query. Either ' +
        'way the wrapped assertion below has stopped proving anything.',
    ).toContain(CANARY);
    expect(text).toContain(CIPHERTEXT_CANARY);
  });

  it('leaks nothing through a wrapped client', () => {
    const text = errorText(wrappedFailure);

    expect(text, 'the redaction let a bound parameter through').not.toContain(CANARY);
    expect(text).not.toContain(CIPHERTEXT_CANARY);
  });

  /**
   * Stripping the values must not strip what makes the error useful. The query
   * text names the table and the columns and contains no values, so it stays.
   */
  it('still names the table it failed on', () => {
    const text = errorText(wrappedFailure);

    expect(text).toContain('assistants');
    expect(text).toMatch(/\[redacted\]/);
  });

  /** Nothing was written, so the failure was a failure rather than a slow success. */
  it('wrote no row', async () => {
    const hits = await withTestPool(async (inspection) => {
      const { rows } = await inspection.query<{ hits: string }>(
        'SELECT count(*)::text AS hits FROM assistants WHERE name = $1',
        [CANARY],
      );

      return Number(rows[0]?.hits ?? 0);
    });

    expect(hits).toBe(0);
  });
});

/**
 * The chokepoint claim, proved through production code rather than by reading
 * `getDb()`.
 *
 * `createAssistant` is a real write surface and it takes the client from
 * `getDb()`. If the wrapper were removed from there — or if some call site
 * reached around it — this would leak, because the customer's secret is
 * encrypted before the insert and the ciphertext is bound as a parameter.
 */
describeDatabase('a failing query through the application’s own client', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('carries no ciphertext out of a failed createAssistant', async () => {
    const failure = await captureFailure(() =>
      createAssistant('no-such-account-forcing-a-constraint-failure', {
        name: `redaction probe ${randomUUID()}`,
        serverUrl: 'https://hooks.example.invalid/inbound',
        serverSecret: CANARY,
      }),
    );

    const text = errorText(failure);

    // The plaintext is absent by construction — encryption runs before the
    // insert — so its absence proves nothing on its own. The ciphertext is the
    // interesting one: it *is* a bound parameter, and `v1.` is its only
    // possible shape.
    expect(text).not.toContain(CANARY);
    expect(text, 'a ciphertext reached the error text').not.toMatch(/v1\.[A-Za-z0-9_-]/);

    // The error is still a useful one rather than an empty husk.
    expect(text).toContain('assistants');
  });

  /**
   * The wrapper has to survive the whole chain, not just its first link.
   * Drizzle's builders are chained thenables, so a proxy that forwarded
   * `insert` without re-wrapping what it returned would leave `.values()` and
   * `.returning()` unprotected — and `.returning()` is what every write in
   * `src/data/` actually awaits.
   */
  it('redacts a failure awaited at the end of a longer chain', async () => {
    const chained = `canary-chained-${randomUUID()}`;

    const failure = await captureFailure(() =>
      getDb()
        .insert(assistants)
        .values({
          id: randomUUID(),
          accountId: 'no-such-account-forcing-a-constraint-failure',
          name: chained,
        })
        .returning({ id: assistants.id }),
    );

    const text = errorText(failure);

    expect(failure).toBeInstanceOf(Error);
    expect(text, 'the last link of the chain was not wrapped').not.toContain(chained);
    expect(text).toContain('assistants');
  });
});
