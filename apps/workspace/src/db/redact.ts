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

  if (PARAMS_SECTION.test(error.message)) {
    error.message = error.message.replace(
      PARAMS_SECTION,
      '\nparams: [redacted]',
    );
  }

  // `.stack` must be rewritten too, and this is structural rather than
  // belt-and-braces. V8 formats the stack string once, lazily, and caches it
  // — so if anything read `.stack` before this ran, that string still holds
  // the original message with its parameters. `console.error(err)` and Next's
  // own logger print `.stack`, not `.message`, so redacting only the message
  // leaves the values in the exact field most loggers emit.
  //
  // Verified on Node 24.21.0: mutate the message without touching `.stack`
  // first and the stack is clean; read `.stack` first and the parameters
  // survive there. Whether that happens depends on who touched the error
  // before us, which is not a property to rely on.
  if (typeof error.stack === 'string' && PARAMS_SECTION.test(error.stack)) {
    error.stack = error.stack.replace(PARAMS_SECTION, '\nparams: [redacted]');
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
 */
function redacting<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;

      if (property === 'then' && typeof value === 'function') {
        return function chainedThen(
          onFulfilled?: (v: unknown) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) {
          return (value as (...a: unknown[]) => unknown).call(
            object,
            onFulfilled,
            (error: unknown) => {
              const redacted = redactQueryParams(error);
              if (onRejected) {
                return onRejected(redacted);
              }
              throw redacted;
            },
          );
        };
      }

      if (typeof value === 'function') {
        return function forwarded(...args: unknown[]) {
          const result = (value as (...a: unknown[]) => unknown).apply(
            object,
            args,
          );

          return typeof result === 'object' && result !== null
            ? redacting(result)
            : result;
        };
      }

      return value;
    },
  }) as T;
}

export { redacting as withRedactedQueryErrors };
