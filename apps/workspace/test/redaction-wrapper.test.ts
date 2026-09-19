import { describe, expect, it } from 'vitest';

import { redactQueryParams, withRedactedQueryErrors } from '@/db/redact';

/**
 * What the redaction wrapper must preserve while it is busy redacting.
 *
 * The wrapper's job is to catch rejections, and three times now a change that
 * did that job correctly has quietly broken something else the wrapper was
 * silently promising: the stack frames, `finally`'s contract, and — the subject
 * of this file — **reference equality**.
 *
 * Wrapping every object-valued property read built a fresh proxy per read, so
 * `client.x === client.x` was `false`. Nothing failed loudly. It just meant
 * that anything comparing by identity, or keying a `Map`, `Set` or `WeakMap`
 * on a value read through the client, silently missed — and Drizzle and Better
 * Auth both hold schema and table objects, which are exactly the kind of thing
 * keyed by identity.
 *
 * These are deliberately **not** database-backed. The property is pure, it
 * holds for any wrapped object, and a rule this easy to break should be
 * checked in a fresh clone with no database rather than only where one is
 * configured.
 */

/** A target with one of each kind of property the wrapper has to deal with. */
function subject() {
  const nested = { deep: { deeper: 1 } };

  return {
    nested,
    list: [1, 2, 3],
    method() {
      return nested;
    },
    scalar: 7,
    text: 'unchanged',
    nothing: null as unknown,
  };
}

describe('reference equality through the wrapper', () => {
  it('returns the same reference for repeated reads of an object property', () => {
    const wrapped = withRedactedQueryErrors(subject());

    expect(wrapped.nested).toBe(wrapped.nested);
  });

  it('returns the same reference for repeated reads of a function property', () => {
    const wrapped = withRedactedQueryErrors(subject());

    expect(wrapped.method).toBe(wrapped.method);
  });

  it('returns the same reference for an array property', () => {
    const wrapped = withRedactedQueryErrors(subject());

    expect(wrapped.list).toBe(wrapped.list);
  });

  /**
   * The count, because `toBe` twice would pass on a cache that held exactly
   * one entry and thrashed. Five reads must produce one object — before the
   * memoisation they produced five.
   */
  it('produces one wrapper across many reads, not one per read', () => {
    const wrapped = withRedactedQueryErrors(subject());
    const seen = new Set<unknown>();

    for (let read = 0; read < 5; read += 1) {
      seen.add(wrapped.nested);
    }

    expect(seen.size).toBe(1);
  });

  it('keeps nested reads stable too', () => {
    const wrapped = withRedactedQueryErrors(subject());

    expect(wrapped.nested.deep).toBe(wrapped.nested.deep);
  });
});

/**
 * The consequence that made the defect matter rather than merely being untidy.
 * A `WeakMap` keyed on a value read through the wrapper has to find it again
 * on the next read; with a fresh proxy per read the lookup silently missed and
 * the caller saw "not present" rather than an error.
 */
describe('identity-keyed collections', () => {
  it('round-trips a WeakMap keyed on a value read through the wrapper', () => {
    const wrapped = withRedactedQueryErrors(subject());
    const registry = new WeakMap<object, string>();

    registry.set(wrapped.nested, 'registered');

    expect(registry.get(wrapped.nested)).toBe('registered');
    expect(registry.has(wrapped.nested)).toBe(true);
  });

  it('round-trips a Set keyed on a function read through the wrapper', () => {
    const wrapped = withRedactedQueryErrors(subject());
    const seen = new Set<unknown>();

    seen.add(wrapped.method);

    expect(seen.has(wrapped.method)).toBe(true);
    expect(seen.size).toBe(1);
  });
});

/**
 * Memoising introduces its own way to be wrong: a cache keyed on the property
 * name alone keeps handing back a wrapper around a value that is no longer
 * there. The cache stores the raw value it wrapped, so a reassigned property
 * is rebuilt rather than served stale.
 */
describe('a reassigned property', () => {
  it('is rewrapped rather than served from the cache', () => {
    const target = subject();
    const wrapped = withRedactedQueryErrors(target);

    const before = wrapped.nested;
    const replacement = { deep: { deeper: 99 } };

    target.nested = replacement;

    const after = wrapped.nested;

    expect(after, 'the cache served a wrapper around the old value').not.toBe(before);
    expect(after.deep.deeper).toBe(99);
  });

  it('is stable again once it has been rewrapped', () => {
    const target = subject();
    const wrapped = withRedactedQueryErrors(target);

    target.nested = { deep: { deeper: 42 } };

    expect(wrapped.nested).toBe(wrapped.nested);
  });
});

/**
 * Values that are not objects have no wrapper to memoise, and must come back
 * exactly as they are. A wrapper that boxed a primitive would break `===`
 * against a literal, which is how most of this codebase compares them.
 */
describe('values that are not wrapped', () => {
  it.each([
    ['a number', 'scalar', 7],
    ['a string', 'text', 'unchanged'],
    ['null', 'nothing', null],
  ])('passes %s through untouched', (_label, key, value) => {
    const wrapped = withRedactedQueryErrors(subject()) as unknown as Record<string, unknown>;

    expect(wrapped[key]).toBe(value);
  });

  it('does not invent properties the target does not have', () => {
    const wrapped = withRedactedQueryErrors(subject()) as unknown as Record<string, unknown>;

    expect(wrapped.absent).toBeUndefined();
  });
});

/**
 * Two wrapped targets must not share a cache entry. The cache is keyed by
 * target first, so one object's `nested` can never be served for another's —
 * which a single property-keyed map would do.
 */
describe('two wrapped targets', () => {
  it('do not share wrappers', () => {
    const first = withRedactedQueryErrors(subject());
    const second = withRedactedQueryErrors(subject());

    expect(first.nested).not.toBe(second.nested);
    expect(first.nested).toBe(first.nested);
    expect(second.nested).toBe(second.nested);
  });
});

/**
 * `finally`, compared against native rather than described.
 *
 * This property has now been traded away three times, and each fix asserted
 * something weaker than the last failure deserved. First the callback did not
 * run on rejection at all. Then it ran but an async callback was never
 * awaited, so `await query.finally(async () => releaseLock())` resumed with
 * the lock still held — cleanup that nominally happened and was not finished.
 * Then a callback returning a rejected promise was orphaned, which under
 * Node's default `--unhandled-rejections=throw` **terminates the process**.
 *
 * So the assertion is not "the callback ran". That was the second fix and it
 * was still wrong twice over. The property is **indistinguishable from native
 * `finally`, in ordering and in settlement**, and the only honest way to check
 * that is to run the same scenario against a real `Promise` and against the
 * wrapper and compare the two transcripts.
 *
 * No database: `finally`'s contract is a language guarantee, and a rule this
 * easy to get subtly wrong should be checked in a fresh clone.
 */

/** A minimal stand-in for Drizzle's `QueryPromise`: a thenable with the trio. */
function fakeQuery(settle: () => Promise<unknown>) {
  const query = {
    then(onFulfilled?: unknown, onRejected?: unknown) {
      return settle().then(
        onFulfilled as (v: unknown) => unknown,
        onRejected as (e: unknown) => unknown,
      );
    },
    catch(onRejected?: unknown) {
      return query.then(undefined, onRejected);
    },
    // Present and a function so the wrapper's interception engages. The
    // wrapper never calls this one — it reimplements `finally` on top of
    // `then` — which is precisely what has to match native.
    finally(callback?: unknown) {
      return query.then(
        (value: unknown) => {
          (callback as () => void)?.();
          return value;
        },
        (error: unknown) => {
          (callback as () => void)?.();
          throw error;
        },
      );
    },
  };

  return query;
}

/**
 * Runs one scenario and returns a transcript: what happened, in what order,
 * and how it settled. Identical transcripts mean identical behaviour.
 */
async function transcribe(
  build: (settle: () => Promise<unknown>) => { finally: (cb: () => unknown) => PromiseLike<unknown> },
  settle: () => Promise<unknown>,
  callback: (order: string[]) => () => unknown,
): Promise<{ order: string[]; outcome: string }> {
  const order: string[] = [];
  let outcome: string;

  try {
    const value = await build(settle).finally(callback(order));
    outcome = `fulfilled:${String(value)}`;
  } catch (error) {
    outcome = `rejected:${(error as Error).message}`;
  }

  order.push(`settled(${outcome})`);

  return { order, outcome };
}

/** Native `Promise` in the same shape as `fakeQuery`, for side-by-side runs. */
const nativeQuery = (settle: () => Promise<unknown>) => ({
  finally: (callback: () => unknown) => settle().finally(callback),
});

const wrappedQuery = (settle: () => Promise<unknown>) =>
  withRedactedQueryErrors(fakeQuery(settle)) as unknown as {
    finally: (callback: () => unknown) => PromiseLike<unknown>;
  };

const resolves = () => Promise.resolve('value');
const rejects = () => Promise.reject(new Error('query failed'));

/** A callback that does asynchronous work, which native `finally` awaits. */
const asyncCleanup = (order: string[]) => async () => {
  order.push('cleanup-start');
  await Promise.resolve();
  await Promise.resolve();
  order.push('cleanup-end');
};

/** A callback that rejects. Native replaces the settlement with its reason. */
const rejectingCleanup = () => () => Promise.reject(new Error('from-cleanup'));

describe('finally matches native', () => {
  it.each([
    ['a resolving query', resolves],
    ['a rejecting query', rejects],
  ])('awaits an async callback before settling — %s', async (_label, settle) => {
    const native = await transcribe(nativeQuery, settle, asyncCleanup);
    const wrapped = await transcribe(wrappedQuery, settle, asyncCleanup);

    // The ordering is the point: `cleanup-end` must come before `settled`, or
    // the caller resumes while cleanup is still in flight.
    expect(native.order).toStrictEqual([
      'cleanup-start',
      'cleanup-end',
      `settled(${native.outcome})`,
    ]);
    expect(
      wrapped.order,
      'the wrapper settled before its async callback finished — a lock released ' +
        'in that callback is still held when the caller resumes',
    ).toStrictEqual(native.order);
  });

  it.each([
    ['a resolving query', resolves],
    ['a rejecting query', rejects],
  ])('settles with the callback’s rejection — %s', async (_label, settle) => {
    const native = await transcribe(nativeQuery, settle, rejectingCleanup);
    const wrapped = await transcribe(wrappedQuery, settle, rejectingCleanup);

    expect(native.outcome).toBe('rejected:from-cleanup');
    expect(
      wrapped.outcome,
      'a callback returning a rejected promise was not adopted — under Node’s ' +
        'default --unhandled-rejections=throw that orphaned rejection ends the ' +
        'process',
    ).toBe(native.outcome);
  });

  it.each([
    ['a resolving query', resolves],
    ['a rejecting query', rejects],
  ])('passes the original settlement through a plain callback — %s', async (_label, settle) => {
    const plain = () => () => undefined;

    const native = await transcribe(nativeQuery, settle, plain);
    const wrapped = await transcribe(wrappedQuery, settle, plain);

    expect(wrapped.outcome).toBe(native.outcome);
    expect(wrapped.order).toStrictEqual(native.order);
  });

  /**
   * The orphaned rejection is the one that kills the process, so it is checked
   * directly rather than only through the settlement above: nothing may reach
   * the `unhandledRejection` handler.
   */
  it('produces no unhandled rejection when the callback rejects', async () => {
    const orphaned: unknown[] = [];
    const listener = (reason: unknown) => orphaned.push(reason);

    process.on('unhandledRejection', listener);

    try {
      await transcribe(wrappedQuery, rejects, rejectingCleanup).catch(() => undefined);
      // Two macrotask turns: an orphaned rejection is reported after the
      // microtask queue drains, so checking synchronously would always pass.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(orphaned).toStrictEqual([]);
  });
});

/**
 * A frozen error must not throw *out of* the redaction.
 *
 * `redactQueryParams` runs inside a rejection handler, so anything it throws
 * replaces the customer's error with a `TypeError` about assigning to a
 * read-only property — losing the real failure entirely. Freezing is not
 * something Drizzle does today; this is a guard against the redaction being
 * the thing that breaks, which is a worse outcome than not redacting.
 */
describe('a frozen error', () => {
  it('does not throw out of the redaction', () => {
    const error = Object.freeze(
      new Error('Failed query: insert into x\nparams: frozen-canary'),
    );

    expect(() => redactQueryParams(error)).not.toThrow();
  });

  it('is still returned to the caller rather than swallowed', () => {
    const error = Object.freeze(new Error('Failed query: x\nparams: frozen-canary'));

    expect(redactQueryParams(error)).toBe(error);
  });
});

/**
 * **The sweep must not destroy the error it is cleaning.**
 *
 * Stated as a property rather than inferred from a canary, because absence is
 * the one thing a leak check cannot distinguish: "the canary is not in the
 * message" is satisfied by a redacted message *and* by a message that has been
 * replaced with the literal string `[redacted]`, and the second is how a
 * database error stops naming the table, the columns, or the call site.
 *
 * That is not hypothetical. Switching the own-property sweep from
 * `Object.keys` to `Reflect.ownKeys` — to catch symbol keys, which was correct
 * — also caught `message` and `stack`, because they are own **non-enumerable**
 * properties on every `Error` and `Object.keys` had been skipping them for
 * free. Both became `[redacted]` in full, and every leak assertion in the
 * suite still passed.
 *
 * These are unit-level and need no database, so they fire the moment such a
 * line is written rather than after a database-backed file gets that far.
 */
describe('what the redaction must leave intact', () => {
  /** Shaped like a `DrizzleQueryError`: query text, bound params, a cause. */
  function queryError() {
    const error = new Error(
      'Failed query: select "id" from "widgets" where "name" = $1\nparams: secret-value',
      { cause: new Error('duplicate key value violates unique constraint') },
    ) as Error & { query?: string; params?: unknown[] };

    error.query = 'select "id" from "widgets" where "name" = $1';
    error.params = ['secret-value'];

    return error;
  }

  it('keeps the query text in the message', () => {
    const redacted = redactQueryParams(queryError()) as Error;

    expect(redacted.message).toContain('widgets');
    expect(redacted.message).toContain('select');
    expect(redacted.message).not.toBe('[redacted]');
  });

  it('keeps the stack’s frames and its header', () => {
    const redacted = redactQueryParams(queryError()) as Error;
    const stack = String(redacted.stack);

    expect(stack, 'the stack was replaced wholesale').not.toBe('[redacted]');
    expect(stack).toContain('widgets');
    expect(stack, 'the stack has no frames left').toMatch(/\n\s+at /);
  });

  it('still removes the bound values from both', () => {
    const redacted = redactQueryParams(queryError()) as Error;

    expect(redacted.message).not.toContain('secret-value');
    expect(String(redacted.stack)).not.toContain('secret-value');
    expect(
      (redacted as Error & { params?: unknown }).params,
      'the params property kept its values',
    ).toBe('[redacted]');
  });

  it('keeps the query property, which carries placeholders and no values', () => {
    const redacted = redactQueryParams(queryError()) as Error & { query?: string };

    expect(redacted.query).toContain('widgets');
    expect(redacted.query).not.toBe('[redacted]');
  });

  /**
   * The same property one level down. `cause` is recursed into rather than
   * blanked, so a sweep that flattened it would lose why the query failed
   * while still reporting no leak.
   */
  it('keeps the cause’s own message', () => {
    const redacted = redactQueryParams(queryError()) as Error;
    const cause = redacted.cause as Error;

    expect(cause).toBeInstanceOf(Error);
    expect(cause.message).toContain('unique constraint');
    expect(cause.message).not.toBe('[redacted]');
  });

  /**
   * An error with no parameters at all must come back untouched. A sweep that
   * rewrote every error it saw would corrupt failures that never carried a
   * value — a connection refusal, a timeout — and those are the ones read at
   * three in the morning.
   */
  it('leaves an error that never carried parameters alone', () => {
    const plain = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const redacted = redactQueryParams(plain) as Error;

    expect(redacted.message).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    expect(String(redacted.stack)).toMatch(/\n\s+at /);
  });
});

/**
 * The redaction's own sweep must reach non-enumerable properties.
 *
 * `Reflect.ownKeys` sees them and `Object.keys` does not, and that difference
 * is not academic: the swap was made once in this file's history, and it was
 * reverted because it also caught `message` and `stack` and obliterated both.
 * The correct fix was to keep `Reflect.ownKeys` and put `message` and `stack`
 * on the keep list — so the failure mode to guard is somebody undoing the
 * sweep rather than the keep list, for the entirely reasonable reason that the
 * sweep is what broke things last time.
 */
describe('the own-property sweep', () => {
  function errorWithHiddenParams(): Error {
    const error = new Error('Failed query: select 1');
    Object.defineProperty(error, 'params', {
      value: ['SWEEP-CANARY'],
      enumerable: false,
      writable: true,
      configurable: true,
    });

    return error;
  }

  it('blanks a value hidden on a non-enumerable property', () => {
    const redacted = redactQueryParams(errorWithHiddenParams()) as Error & {
      params?: unknown;
    };

    expect(
      redacted.params,
      'a non-enumerable property kept its value — the sweep is using ' +
        'Object.keys, which cannot see it',
    ).toBe('[redacted]');
  });

  it('still leaves message and stack intact while doing it', () => {
    const redacted = redactQueryParams(errorWithHiddenParams()) as Error;

    expect(redacted.message).toContain('select 1');
    expect(String(redacted.stack)).toMatch(/\n\s+at /);
  });

  it('blanks a value hidden under a symbol key', () => {
    const key = Symbol('params');
    const error = new Error('Failed query: select 1') as Error &
      Record<symbol, unknown>;
    error[key] = ['SYMBOL-CANARY'];

    const redacted = redactQueryParams(error) as Record<symbol, unknown>;

    expect(redacted[key]).toBe('[redacted]');
  });
});
