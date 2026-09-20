/**
 * Fixtures for the tool summary and the assistant editor.
 *
 * Both suites describe the same artefact from opposite ends — the summary reads
 * a tool list, the editor submits one — so the shapes live in one place. Two
 * copies of "a valid tool" that drift is how a summary test starts passing
 * against input the editor can no longer produce.
 */

/** A tool in the flat shape, valid in every respect. */
export function flatTool(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'lookup_order',
    description: 'Looks up an order by its reference.',
    parameters: {
      type: 'object',
      properties: { reference: { type: 'string' } },
      required: ['reference'],
    },
    ...overrides,
  };
}

/**
 * The same tool in the wrapped OpenAI shape.
 *
 * Takes the flat tool rather than duplicating its fields, so a change to what
 * counts as valid cannot apply to one shape and not the other — which would
 * leave the wrapped path asserting against a tool the flat path already
 * rejects, and read as coverage.
 */
export function wrappedTool(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'function', function: flatTool(overrides) };
}

/**
 * A string that appears nowhere in this repository and nowhere in any message
 * the summary could legitimately write.
 *
 * Used to prove a rejection does not echo its input. A canary is necessary
 * because "the error does not contain the input" is trivially satisfiable by an
 * error that contains nothing useful, and equally by a detector that never
 * matches anything — so `expectAbsent` below is exercised against a control
 * that genuinely leaks. Absence of a canary is only evidence when the detector
 * has been shown to find one.
 */
export const CANARY = 'zzQ-canary-8f3a1c-do-not-echo-zzQ';

/**
 * Fails if `haystack` carries the canary.
 *
 * Deliberately a plain function rather than an inline `expect`, so the control
 * test can call it and assert that it throws.
 */
export function expectAbsent(haystack: string, canary: string = CANARY): void {
  if (haystack.includes(canary)) {
    throw new Error(
      `Expected the text not to echo its input, but it contained ${canary}.`,
    );
  }
}
