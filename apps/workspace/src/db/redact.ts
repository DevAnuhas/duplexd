/**
 * Strips bound query parameters out of database errors.
 *
 * Drizzle builds `DrizzleQueryError`'s message as
 * `` `Failed query: ${query}\nparams: ${params}` ``, so any failing statement
 * carries its bound values into whatever catches it — a log aggregator, an
 * error reporter, a stack trace in a response. For this schema that means the
 * ciphertext of a customer's webhook secret, which is a decryption oracle away
 * from the plaintext the moment the encryption key is compromised.
 *
 * This was found by running a `BEFORE INSERT ... RAISE EXCEPTION` trigger
 * against the merged P02 code: the plaintext was absent, because encryption
 * happens before the insert, but the full `v1.` ciphertext was in the message.
 * `pg` never emits that text — it is Drizzle's wrapper — so looking in the
 * client's options finds nothing and suggests there is nothing to find.
 *
 * One chokepoint rather than per-call-site care: every future column is
 * covered, not only the two this ticket happens to add.
 */

/**
 * The parameter section Drizzle appends to a failed query's message.
 *
 * **Before loosening this to keep parameters for debuggability, read on.** The
 * temptation is real — a failed insert is much easier to diagnose with its
 * values — and the answer is that this schema carries things that must never
 * reach a log at all.
 *
 * Today that is the ciphertext of a customer's webhook secret, which is one
 * key compromise away from the plaintext. From P05 it is worse: `call_events`
 * payloads carry **transcripts**, and `docs/OPERATIONS.md` says in terms never
 * to log those in full. A failing insert there would put the caller's own
 * words into the log aggregator.
 *
 * So this strips every bound value and keeps only the query text, which names
 * tables and columns and is what makes the error useful in the first place.
 * If a specific value is genuinely needed to debug something, log it
 * deliberately at that call site where a reviewer can see what is being
 * exposed — do not widen the chokepoint for everything.
 *
 * **This is end-anchored, and that is only correct because it is applied to a
 * message and never to a stack.** Getting here took two wrong turns worth
 * recording, because both look right in isolation.
 *
 * Anchoring to the end and applying it to `.stack` destroys every frame: on a
 * stack everything after `\nparams:` *is* the frames. Bounding it with a
 * lookahead for the first ` at ` frame then leaks, because that boundary is
 * derived from the parameter values themselves — and those are customer free
 * text. An `instructions` textarea containing an ordinary wrapped sentence
 * ("Greet the caller.\n    at all times be polite.") is indistinguishable from
 * a stack frame, the redaction stops there, and every parameter bound after
 * that column survives. `server_secrets` is two columns downstream of
 * `instructions`, so the leak lands on exactly the value this file exists to
 * protect.
 *
 * So the boundary is never guessed from content. See `redactQueryParams`: the
 * stack is repaired by splicing the redacted message over the original
 * message's span, which the stack begins with by construction.
 */
const PARAMS_SECTION = /\nparams:[\s\S]*$/;

/**
 * Returns `error` with any bound parameters removed from its message and from
 * every error in its `cause` chain.
 *
 * The query text is kept: it names tables and columns, which is what makes the
 * error useful, and contains no values.
 */
export function redactQueryParams(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const original = error.message;

  // Read `.stack` before mutating the message. V8 formats it once, lazily, and
  // caches the result — so reading it here pins a string built from the
  // original message, which is exactly the span we need to find below.
  const stack = typeof error.stack === 'string' ? error.stack : null;

  if (PARAMS_SECTION.test(original)) {
    error.message = original.replace(PARAMS_SECTION, '\nparams: [redacted]');
  }

  // `.stack` matters as much as `.message`: `console.error(err)` and Next's
  // own logger print the stack, so redacting only the message would clean the
  // field nobody emits and leave the one they do.
  //
  // It is repaired by splicing rather than by pattern-matching. A stack begins
  // with `${name}: ${message}` followed by the frames, so the original message
  // locates its own span exactly — no rule has to guess where values end and
  // frames begin, which is the guess that leaked. Frames survive byte-for-byte
  // because they are never touched.
  //
  // `indexOf` returning -1 is the benign case: the stack had not been
  // formatted before this ran, so it was built from the already-redacted
  // message and needs nothing.
  if (stack !== null && error.message !== original) {
    const start = stack.indexOf(original);

    error.stack =
      start === -1
        ? stack
        : stack.slice(0, start) +
          error.message +
          stack.slice(start + original.length);
  }

  // **The third place a value hides, and the one that actually gets logged.**
  // `DrizzleQueryError` does not only build its message from the parameters,
  // it keeps them: `this.query`, `this.params`. Those are own enumerable
  // properties, so `util.inspect` prints them — and `console.error(err)`,
  // `JSON.stringify(err)`, Sentry and pino all serialise own properties. Next
  // logs a caught error with `console.error(prefix, err)`, which means the
  // values reach the log through inspect even when `.message` and `.stack` are
  // spotless. Redacting only those two was cosmetic against the field the
  // framework actually emits.
  //
  // The rule is an allowlist, not a list of things to strip. `query` is kept
  // because it is the parameterised SQL — placeholders, no values — and it is
  // what makes the error diagnosable. Everything else is blanked, so a future
  // library version that attaches a new value-bearing property is covered
  // without anyone noticing it appeared. That is the same reason item 22c
  // gives for stripping all parameters rather than secret-shaped ones.
  for (const key of Object.keys(error)) {
    if (key === 'query' || key === 'cause') {
      continue;
    }

    try {
      (error as unknown as Record<string, unknown>)[key] = '[redacted]';
    } catch {
      // A getter-only or frozen property cannot be blanked. Skipping is the
      // honest outcome; the message and stack are still clean.
    }
  }

  if (error.cause !== undefined && error.cause !== null) {
    redactQueryParams(error.cause);
  }

  return error;
}

/**
 * Wraps a Drizzle client so every query rejecting through it is redacted.
 *
 * This sits on `getDb()` rather than on each data function on purpose. A
 * wrapper that one call site can skip is worse than none, because it reads as
 * protection while leaving a hole — and there is a caller here that could
 * never opt in anyway: Better Auth's Drizzle adapter receives this same
 * client and runs its own queries through it, carrying emails and credential
 * rows. One chokepoint covers it, every function in `src/data/`, and whatever
 * P05 adds, without any of them knowing this exists.
 *
 * The proxy is the least obvious thing in this codebase, and the reason is
 * worth stating: Drizzle's query builders are chained thenables, so the only
 * place a rejection can be caught for *every* caller is between the builder
 * and its `await`. Intercepting `then` is what makes coverage provable rather
 * than a matter of each new call site remembering.
 *
 * Everything else is forwarded untouched, and any object a method returns is
 * wrapped the same way so the chain keeps its shape.
 *
 * **Wrappers are memoised, and that is a correctness requirement rather than a
 * performance one.** Building a fresh wrapper per property read makes
 * `client.x === client.x` evaluate to `false`, because the two reads return
 * two different proxies. Anything that compares by identity, or keys a `Map`,
 * `Set` or `WeakMap` on a value read through the client, then silently misses
 * — and Drizzle and Better Auth both hold schema and table objects, which are
 * exactly the kind of thing keyed by identity. Measured before fixing: five
 * reads of one property produced five distinct proxies.
 *
 * The cache is keyed by target and property **and stores the raw value it
 * wrapped**, so a property that is later reassigned gets a fresh wrapper
 * instead of a stale one pointing at the old value. Keying on the property
 * alone would cache a wrapper around a value that is no longer there; keying
 * on the value alone would hand a `then` wrapper to a non-`then` property that
 * happened to share a function.
 */
type Wrapped = { source: unknown; wrapper: unknown };

const wrapperCache = new WeakMap<object, Map<string | symbol, Wrapped>>();

function memoise(
  object: object,
  property: string | symbol,
  source: unknown,
  build: () => unknown,
): unknown {
  let byProperty = wrapperCache.get(object);

  if (byProperty === undefined) {
    byProperty = new Map();
    wrapperCache.set(object, byProperty);
  }

  const cached = byProperty.get(property);

  if (cached !== undefined && cached.source === source) {
    return cached.wrapper;
  }

  const wrapper = build();
  byProperty.set(property, { source, wrapper });

  return wrapper;
}

function redacting<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;

      // `then`, `catch` and `finally` all need intercepting. Drizzle's
      // `QueryPromise.catch(fn)` is `this.then(undefined, fn)` — but `this`
      // there is the raw target, not the proxy, so a caller using `.catch()`
      // or `.finally()` instead of `await` would route around the redaction
      // entirely.
      if (
        (property === 'then' || property === 'catch' || property === 'finally') &&
        typeof value === 'function'
      ) {
        return memoise(object, property, value, () => function settled(...handlers: unknown[]) {
          const redact = (handler: unknown) => (error: unknown) => {
            const redacted = redactQueryParams(error);

            if (typeof handler === 'function') {
              return (handler as (e: unknown) => unknown)(redacted);
            }

            throw redacted;
          };

          if (property === 'then') {
            return (value as (...a: unknown[]) => unknown).call(
              object,
              handlers[0],
              redact(handlers[1]),
            );
          }

          if (property === 'catch') {
            return (object as { then: (...a: unknown[]) => unknown }).then(
              undefined,
              redact(handlers[0]),
            );
          }

          // `finally` does not receive the error, so the redaction has to be
          // attached alongside the callback rather than through it.
          //
          // **The callback runs on BOTH settlements, and that is the entire
          // contract.** An earlier version of this branch passed
          // `redact(undefined)` as the rejection handler, which redacted and
          // rethrew but never called the callback — so cleanup that exists
          // precisely for the failure path (a released lock, a closed span)
          // was skipped on exactly that path. The leak was closed and a
          // property nobody was asserting was traded away for it; that trade
          // is the recurring shape of this file's history, so it is now
          // asserted rather than assumed.
          const onFinally = handlers[0] as (() => unknown) | undefined;

          return (object as { then: (...a: unknown[]) => unknown }).then(
            (result: unknown) => {
              onFinally?.();
              return result;
            },
            (error: unknown) => {
              const redacted = redactQueryParams(error);
              onFinally?.();
              throw redacted;
            },
          );
        });
      }

      if (typeof value === 'function') {
        return memoise(object, property, value, () => function forwarded(...args: unknown[]) {
          const result = (value as (...a: unknown[]) => unknown).apply(
            object,
            args,
          );

          return typeof result === 'object' && result !== null
            ? redacting(result)
            : result;
        });
      }

      // A plain object property is wrapped too. `db.query` — Drizzle's
      // relational read API, which `getDb()` enables by passing `{ schema }` —
      // is an own property rather than a method, so it fell straight through
      // and every query made through it was unprotected. Nothing uses it
      // today, which is precisely why it would have been missed.
      if (typeof value === 'object' && value !== null) {
        return memoise(object, property, value, () => redacting(value));
      }

      return value;
    },
  }) as T;
}

export { redacting as withRedactedQueryErrors };
