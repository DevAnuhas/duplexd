import { inspect } from 'node:util';

/**
 * Gather every place a thrown query error can carry bound values.
 *
 * A blank capture is a false pass, so callers must first prove this collector
 * sees a deliberately unredacted canary before using it as absence evidence.
 */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    parts.push(current.message, String(current.stack ?? ''));
    parts.push(inspect(current, { depth: 8, showHidden: true }));

    for (const key of Reflect.ownKeys(current)) {
      try {
        parts.push(
          String(key),
          inspect((current as unknown as Record<PropertyKey, unknown>)[key], {
            depth: 8,
            showHidden: true,
          }),
        );
      } catch {
        // A throwing getter has already been represented by inspect above.
      }
    }

    try {
      parts.push(JSON.stringify(current) ?? '');
    } catch {
      // Cycles are covered by inspect.
    }

    current = current.cause;
  }

  if (current !== undefined && current !== null && !(current instanceof Error)) {
    parts.push(String(current), inspect(current, { depth: 8, showHidden: true }));
  }

  return parts.join('\n');
}

/** Capture a required failure; success would make every later absence vacuous. */
export async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the operation to fail, but it succeeded; nothing was captured.');
}
