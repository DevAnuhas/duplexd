import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb } from '@/db/client';
import { createAssistant } from '@/data/assistants';
import { withRedactedQueryErrors } from '@/db/redact';
import * as schema from '@/db/schema';
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
 * Everywhere an error can carry a value, gathered into one string.
 *
 * **This function was the defect once, and it is worth saying how.** It used to
 * collect the message, the stack and the `cause` chain, and its docstring
 * claimed that was "everything an error could carry a value in". It was not.
 * `DrizzleQueryError` also keeps `this.query` and `this.params` as own
 * enumerable properties, and own enumerable properties are what
 * `util.inspect` prints — which is what `console.error(err)` prints, which is
 * what Next's logger does with a caught error, and what Sentry, pino and
 * `JSON.stringify` all serialise.
 *
 * So every `not.toContain(CANARY)` in this file was asserted against a string
 * deliberately built to exclude the place the leak actually lived. The
 * assertion and the defect were blind in the same direction, which is the one
 * way a test can be worse than no test: it occupies the slot where a real
 * check would have gone and reports green.
 *
 * The three sources below are therefore gathered separately rather than
 * trusting any one of them to imply the others. `inspect` at depth is the
 * honest stand-in for what a logger emits; `Object.entries` names the own
 * properties explicitly so a future one is included without anyone editing
 * this; `JSON.stringify` is what a structured logger does.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    parts.push(current.message, String(current.stack ?? ''));

    // What `console.error(err)` and every structured logger actually emit.
    //
    // `showHidden` is load-bearing and was missing. `message` and `stack` are
    // own **non-enumerable** properties on every `Error`, and a library is free
    // to attach a value-bearing one the same way — `Object.entries`,
    // `JSON.stringify` and a default `inspect` all skip those, so this helper
    // was blind to exactly the properties the redaction's `Reflect.ownKeys`
    // sweep exists to blank. Production was stricter than the test guarding it,
    // which is safe right up until somebody reverts that sweep to
    // `Object.keys` — a change that was made once here already, for the
    // entirely reasonable reason that it had obliterated the message and the
    // stack.
    parts.push(inspect(current, { depth: 8, showHidden: true }));

    // Named explicitly as well, so a future non-enumerable property is covered
    // without anyone editing this. `getOwnPropertyNames` is the superset;
    // `Object.entries` is kept because it invokes getters, which
    // `getOwnPropertyDescriptor`-based enumeration would not.
    for (const [key, value] of Object.entries(current)) {
      parts.push(key, inspect(value, { depth: 8 }));
    }

    for (const key of Object.getOwnPropertyNames(current)) {
      try {
        parts.push(key, inspect((current as unknown as Record<string, unknown>)[key], { depth: 8 }));
      } catch {
        // A throwing getter tells us nothing; `inspect` above still covered it.
      }
    }

    try {
      parts.push(JSON.stringify(current) ?? '');
    } catch {
      // A cyclic own property cannot be stringified; `inspect` above covers it.
    }

    current = current.cause;
  }

  if (current !== undefined && current !== null && !(current instanceof Error)) {
    parts.push(String(current), inspect(current, { depth: 8 }));
  }

  return parts.join('\n');
}

/**
 * How many stack frames an error still carries.
 *
 * Counted rather than eyeballed because the property it guards is a count: the
 * redaction must remove values and nothing else, and "nothing else" is only
 * checkable against the frames the unredacted error had.
 */
function stackFrames(error: unknown): number {
  return (String((error as Error)?.stack ?? '').match(/\n\s+at /g) ?? []).length;
}

/** One diagnostic field, from the error or anywhere in its `cause` chain. */
function diagnostic(error: unknown, field: string): unknown {
  let current: unknown = error;

  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    const value = (current as unknown as Record<string, unknown>)[field];

    if (value !== undefined) {
      return value;
    }

    current = current.cause;
  }

  return undefined;
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

/**
 * **The helper that gathers the evidence, tested as the subject.**
 *
 * `errorText()` has been the defect twice. First it claimed to gather
 * "everything an error could carry a value in" and skipped own enumerable
 * properties, so every canary assertion in this file was measured against a
 * string built to exclude where the leak lived. Then, once fixed, it was still
 * blind to own **non-enumerable** properties — which is where `message` and
 * `stack` live on every `Error`, and where a library is free to hang a value.
 *
 * So the helper gets its own tests, and they assert the **property** rather
 * than today's shape: a value hidden anywhere an error can hide one has to
 * come out. Without these, the widening above is one careless revert away from
 * silently un-widening, and nothing else in the suite would notice — the leak
 * tests would keep passing, because they would keep asking a question that had
 * quietly stopped reaching the answer.
 *
 * No database: this is a property of the helper, not of any query.
 */
describe('errorText finds a value wherever it hides', () => {
  const hidden = 'hidden-canary-value';

  it.each([
    [
      'an own enumerable property',
      () => Object.assign(new Error('failed'), { params: [hidden] }),
    ],
    [
      'an own NON-enumerable property',
      () => {
        const error = new Error('failed');
        Object.defineProperty(error, 'params', {
          value: [hidden],
          enumerable: false,
          writable: true,
          configurable: true,
        });
        return error;
      },
    ],
    [
      'a getter',
      () => {
        const error = new Error('failed');
        Object.defineProperty(error, 'params', {
          get: () => [hidden],
          enumerable: true,
          configurable: true,
        });
        return error;
      },
    ],
    ['the message', () => new Error(`failed with ${hidden}`)],
    [
      'a cause one level down',
      () =>
        new Error('failed', {
          cause: Object.assign(new Error('inner'), { params: [hidden] }),
        }),
    ],
    [
      'a non-Error cause',
      () => new Error('failed', { cause: { params: [hidden] } }),
    ],
  ])('sees a value on %s', (_label, build) => {
    expect(
      errorText(build()),
      'errorText cannot see this, so every canary assertion in this file is ' +
        'blind to it too',
    ).toContain(hidden);
  });

  /** The control: it does not invent the canary when there is none. */
  it('does not report a value that is not there', () => {
    expect(errorText(new Error('failed'))).not.toContain(hidden);
  });
});

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

  /**
   * The redaction removes values and **nothing else**.
   *
   * This is asserted as a frame count rather than as "the canary is gone",
   * because the canary check passed throughout the period when the redaction
   * was destroying every stack frame it touched and told nobody. `.stack` is
   * what `console.error(err)` and Next's own logger print, so an error whose
   * frames have been eaten reports no call site at all — which is the opposite
   * of the promise this module makes two paragraphs into its own docstring.
   *
   * The unwrapped count is the control. Without it "the wrapped error has
   * frames" could pass on an error that never had any.
   */
  it('keeps every stack frame the unredacted error had', () => {
    const control = stackFrames(unwrappedFailure);

    expect(
      control,
      'the control error carries no stack frames, so the assertion below proves nothing',
    ).toBeGreaterThan(0);

    expect(
      stackFrames(wrappedFailure),
      'the redaction ate the stack frames — every database error now reports no call site',
    ).toBe(control);
  });

  it('leaves a stack that still reads as a stack', () => {
    const stack = String((wrappedFailure as Error).stack);

    expect(stack).toContain('assistants');
    expect(stack).toContain('[redacted]');
    expect(stack).toMatch(/\n\s+at /);
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
 * A bound parameter whose own text looks like a stack frame.
 *
 * The redaction has to find where the parameter section ends. If it decides
 * that by looking for the first line that reads like a stack frame, then the
 * boundary is **decided by the very data it is redacting** — and that data is
 * customer-controlled free text. `instructions` is a box a customer types
 * prose into, and prose wraps:
 *
 *     Greet the caller.
 *         at all times be polite.
 *
 * is an entirely ordinary thing to write and is indistinguishable, to a regex,
 * from a `    at Object.<anonymous> (...)` frame. The redaction stops there,
 * and every parameter bound *after* that column survives into the message —
 * which for `assistants` means `server_secrets`, the customer's encrypted
 * webhook secret, two columns later.
 *
 * So this is not a corner case dressed up: it is the leak item 22a exists to
 * close, reachable by typing a wrapped sentence into a textarea.
 *
 * Both halves are asserted together on purpose. Keeping the frames and
 * containing the values are simultaneous requirements, and any boundary
 * derived from the message's *content* trades one against the other. Finding
 * the boundary structurally — the stack's head is exactly the error's own
 * message, so splicing the redacted message back over it preserves the frames
 * byte-for-byte without ever guessing — satisfies both at once.
 */
describeDatabase('a parameter whose own text looks like a stack frame', () => {
  /** Prose that wraps. Nothing exotic, and nothing a customer would think twice about. */
  const FRAME_SHAPED = 'Greet the caller.\n    at all times be polite.';

  afterAll(async () => {
    await closeDb();
  });

  it('does not let the parameters after it escape the redaction', async () => {
    const canary = `canary-injection-${randomUUID()}`;

    const failure = await captureFailure(() =>
      createAssistant('no-such-account-forcing-a-constraint-failure', {
        name: `injection probe ${randomUUID()}`,
        instructions: FRAME_SHAPED,
        serverUrl: `https://${canary}.example.invalid/hook`,
        serverSecret: `canary-secret-${randomUUID()}`,
      }),
    );

    const text = errorText(failure);

    expect(
      text,
      'a parameter bound after the frame-shaped one survived the redaction',
    ).not.toContain(canary);

    // The one that matters: the customer's encrypted webhook secret is bound
    // two columns after `instructions`, so it is downstream of the boundary.
    expect(
      text,
      'the customer’s webhook ciphertext reached the error text — this is the ' +
        'leak item 22a closed, reopened by a content-derived redaction boundary',
    ).not.toMatch(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]/);
  });

  /**
   * And the frames still survive. Stated as its own test so a fix that
   * contained the leak by going back to an end-anchored regex fails here
   * rather than trading one defect for the other.
   */
  it('still keeps its stack frames', async () => {
    const failure = await captureFailure(() =>
      createAssistant('no-such-account-forcing-a-constraint-failure', {
        name: `injection frames ${randomUUID()}`,
        instructions: FRAME_SHAPED,
      }),
    );

    expect(
      stackFrames(failure),
      'the redaction ate the stack frames on the frame-shaped parameter',
    ).toBeGreaterThan(0);
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

/**
 * Every route out of the client, not only `await` on a builder.
 *
 * A chokepoint is only a chokepoint if there is no way past it, and "one call
 * site can skip it" is worse than having none because it reads as protection.
 * Three routes bypassed it, and the common thread is that none of them is
 * `await db.insert(...)` — which is the shape everything in `src/data/`
 * happens to use today, and therefore the only shape anybody tested.
 *
 *  - **`db.query.*`**, Drizzle's relational read API, is a plain object
 *    property rather than a method, so a proxy that only wrapped functions
 *    forwarded it untouched. `getDb()` passes `{ schema }`, whose entire
 *    purpose is to enable it.
 *  - **`.catch()`** and **`.finally()`** are implemented on Drizzle's
 *    `QueryPromise` in terms of `this.then`, where `this` is the raw target
 *    rather than the proxy — so the interception on `then` never runs.
 *
 * Each test below forces a **real failure with a real bound canary** through
 * its route. None of them asserts that a wrapper exists.
 */
describeDatabase('every route into the client is redacted', () => {
  afterAll(async () => {
    await closeDb();
  });

  /**
   * The control for the three route tests below, and it was missing.
   *
   * Each of those asserts a canary is *absent* after a failure on its route.
   * Absence passes for two reasons: the redaction worked, or the route never
   * carried the canary in the first place — because Drizzle changed what its
   * relational errors contain, or because the query stopped failing the way it
   * used to. Without this, all three would go quietly green on the day the
   * thing they guard stopped being reachable, which is the same defect the
   * `leaks its bound parameters through an unwrapped client` control was
   * written to prevent for the insert path.
   *
   * So: the identical failures through an **unwrapped** client must leak.
   */
  it('leaks through all three routes when the client is not wrapped', async () => {
    const canary = `canary-unwrapped-routes-${randomUUID()}`;

    await withTestPool(async (pool) => {
      const bare = drizzle(pool, { schema });

      const relational = await captureFailure(() =>
        bare.query.calls.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, canary),
              eq(table.durationSecs, 'not-an-integer' as unknown as number),
            ),
        }),
      );

      const viaCatch = await bare
        .insert(assistants)
        .values({
          id: randomUUID(),
          accountId: 'no-such-account-forcing-a-constraint-failure',
          name: canary,
        })
        .catch((error: unknown) => error);

      const viaFinally = await captureFailure(() =>
        bare
          .insert(assistants)
          .values({
            id: randomUUID(),
            accountId: 'no-such-account-forcing-a-constraint-failure',
            name: canary,
          })
          .finally(() => undefined),
      );

      expect(
        errorText(relational),
        'an unwrapped relational query no longer carries its parameters, so the ' +
          'db.query test below has stopped proving anything',
      ).toContain(canary);
      expect(
        errorText(viaCatch),
        'an unwrapped .catch() no longer carries its parameters',
      ).toContain(canary);
      expect(
        errorText(viaFinally),
        'an unwrapped .finally() no longer carries its parameters',
      ).toContain(canary);
    });
  });

  /**
   * A relational read, failed on a bad integer cast while the canary rides
   * along as a second bound parameter.
   *
   * The canary is deliberately **not** the invalid value. PostgreSQL echoes
   * the offending input in its own error text, so a canary that caused the
   * failure would appear in the message no matter how correct the redaction
   * was, and the test would fail forever for the wrong reason.
   */
  it('redacts a failure from db.query, the relational API', async () => {
    const canary = `canary-relational-${randomUUID()}`;

    const failure = await captureFailure(() =>
      getDb().query.calls.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, canary),
            eq(table.durationSecs, 'not-an-integer' as unknown as number),
          ),
      }),
    );

    expect(failure, 'the relational query did not fail, so nothing was proved').toBeInstanceOf(
      Error,
    );
    expect(
      errorText(failure),
      'db.query routed around the redaction — it is a property, not a method',
    ).not.toContain(canary);
  });

  /**
   * Identity on the **real** client, not a toy object.
   *
   * `test/redaction-wrapper.test.ts` pins the property in general; this pins it
   * on the thing that actually broke. `getDb()` returns a memoised client, so
   * these are repeated reads through the same proxy — exactly the shape that
   * produced five distinct objects before the wrappers were memoised, and
   * exactly what Drizzle and Better Auth rely on when they key schema and
   * table objects by identity.
   */
  it('returns a stable reference for db.query on the real client', () => {
    const db = getDb();

    expect(db.query).toBe(db.query);
    expect(db.query.assistants).toBe(db.query.assistants);

    const registry = new WeakMap<object, string>();
    registry.set(db.query, 'registered');

    expect(registry.get(db.query)).toBe('registered');
  });

  it('redacts a failure consumed with .catch()', async () => {
    const canary = `canary-catch-${randomUUID()}`;

    const failure = await getDb()
      .insert(assistants)
      .values({
        id: randomUUID(),
        accountId: 'no-such-account-forcing-a-constraint-failure',
        name: canary,
      })
      .catch((error: unknown) => error);

    expect(failure, '.catch() did not receive an error').toBeInstanceOf(Error);
    expect(
      errorText(failure),
      '.catch() routed around the redaction',
    ).not.toContain(canary);
  });

  it('redacts a failure passed through .finally()', async () => {
    const canary = `canary-finally-${randomUUID()}`;

    const failure = await captureFailure(() =>
      getDb()
        .insert(assistants)
        .values({
          id: randomUUID(),
          accountId: 'no-such-account-forcing-a-constraint-failure',
          name: canary,
        })
        .finally(() => undefined),
    );

    expect(failure, '.finally() swallowed the rejection').toBeInstanceOf(Error);
    expect(
      errorText(failure),
      '.finally() routed around the redaction',
    ).not.toContain(canary);
  });

  /**
   * Intercepting `finally` means owning `finally`'s contract.
   *
   * The whole point of `finally` is that its callback runs on **both**
   * settlements — it is where a lock is released or a span is closed. A
   * wrapper whose `finally` runs the callback on success and silently drops it
   * on failure breaks cleanup on exactly the path cleanup exists for, and
   * nothing in the repository uses `.finally()` today, which is precisely the
   * argument for pinning it now rather than discovering it later.
   */
  it('runs the .finally() callback on both settlements', async () => {
    let ranOnSuccess = false;
    let ranOnFailure = false;

    await getDb()
      .select({ id: assistants.id })
      .from(assistants)
      .limit(1)
      .finally(() => {
        ranOnSuccess = true;
      });

    await captureFailure(() =>
      getDb()
        .insert(assistants)
        .values({
          id: randomUUID(),
          accountId: 'no-such-account-forcing-a-constraint-failure',
          name: `canary-finally-contract-${randomUUID()}`,
        })
        .finally(() => {
          ranOnFailure = true;
        }),
    );

    expect(ranOnSuccess, 'the finally callback did not run on success').toBe(true);
    expect(
      ranOnFailure,
      'the finally callback did not run on failure — cleanup is skipped on ' +
        'exactly the path it exists for',
    ).toBe(true);
  });
});

/**
 * pg's structural diagnostics survive; the field that echoes a value does not.
 *
 * The allowlist blanks everything it does not name, which is the right default
 * — a future library version attaching a value-bearing property is covered
 * without anybody noticing it appeared. But it went too far once: it kept
 * `query` because "it names tables and columns" while blanking the field
 * literally called `table`, so a unique violation arrived as
 * `code="[redacted]" constraint="[redacted]" table="[redacted]"` and was
 * undiagnosable.
 *
 * `detail` is the counter-example that makes the rule real rather than a
 * preference: pg builds it as `Key (prefix)=(dk_live_605b21) already exists.`,
 * so it **echoes the value** and has to go even though it reads like a
 * diagnostic. Keeping `code` and dropping `detail` is the whole distinction
 * between structure and content, and this test is what stops someone
 * "simplifying" the allowlist back in either direction.
 */
describeDatabase('a unique violation', () => {
  let failure: unknown;
  const prefix = `dk_live_${randomUUID().replaceAll('-', '').slice(0, 6)}`;

  beforeAll(async () => {
    const accountId = randomUUID();

    await withTestPool(async (pool) => {
      await pool.query('INSERT INTO accounts (id, name) VALUES ($1, $2)', [
        accountId,
        'diagnostics probe',
      ]);
      await pool.query(
        `INSERT INTO api_keys (id, account_id, name, prefix, key_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), accountId, 'first', prefix, 'a'.repeat(64)],
      );
    });

    // The same prefix again, through the application's own client, so the
    // unique index rejects it and pg's diagnostics come back through the
    // chokepoint.
    failure = await captureFailure(() =>
      getDb().insert(schema.apiKeys).values({
        id: randomUUID(),
        accountId,
        name: 'second',
        prefix,
        keyHash: 'b'.repeat(64),
      }),
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  /** Without this the assertions below could be inspecting the wrong error. */
  it('is a unique violation and not some other failure', () => {
    expect(failure).toBeInstanceOf(Error);
    expect(diagnostic(failure, 'code'), 'not a unique violation').toBe('23505');
  });

  it.each([
    ['code', 'the only way a caller tells a unique violation from a dropped connection'],
    ['table', 'which table rejected the write'],
    ['constraint', 'which constraint rejected it'],
  ])('keeps %s — %s', (field) => {
    const value = diagnostic(failure, field);

    expect(value, `${field} is missing entirely`).toBeDefined();
    expect(value, `${field} was blanked; the error is undiagnosable`).not.toBe(
      '[redacted]',
    );
  });

  it('names the table it actually failed on', () => {
    expect(diagnostic(failure, 'table')).toBe('api_keys');
  });

  /**
   * And the one that has to go, because pg builds it by interpolating the
   * offending value. It is the reason the allowlist cannot simply be "keep
   * anything that looks like a diagnostic".
   */
  it('blanks detail, which echoes the value that collided', () => {
    expect(diagnostic(failure, 'detail')).toBe('[redacted]');
    expect(errorText(failure), 'the colliding prefix reached the error text').not.toContain(
      prefix,
    );
  });

  it('keeps the error’s name, so it does not log as [redacted]: Rollback', () => {
    expect((failure as Error).name).not.toBe('[redacted]');
  });
});
