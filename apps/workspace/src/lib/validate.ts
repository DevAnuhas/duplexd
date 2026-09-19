import Ajv from 'ajv';

/**
 * Validation shared by every write surface.
 *
 * There is one definition of "a valid tool list" and one of "a valid server
 * URL", and both the form and any route handler call them. Two
 * implementations that agree today is how a call-time rejection gets born:
 * the customer saves happily and discovers the problem with a caller on the
 * line.
 */

/**
 * Where a webhook may point.
 *
 * Reproduced byte-for-byte from the retired contracts package, recoverable at
 * `67e48c3^:packages/contracts/src/constants.ts`. It was adversarially
 * reviewed there, and it is reused rather than rewritten because the ways a
 * loopback check fails open are not obvious: `localhost.evil.example` and
 * `127.0.0.1.nip.io` both resolve to attacker-controlled hosts while reading
 * like loopback, and a naive `startsWith` or `includes` accepts them. This
 * pattern anchors the authority, so it does not.
 */
export const SERVER_URL_PATTERN =
  /^(?:https:\/\/(?:\[[0-9a-fA-F:]+\]|[^\s@/?#:[\]]+)(?::[0-9]+)?(?:[/?][^\s#]*)?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?][^\s#]*)?)$/;

/** Provider identifier rules for a tool name. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type ValidationIssue = {
  /** Which field the customer needs to look at. */
  field: string;
  message: string;
};

/** `https:` anywhere, or `http:` on loopback for local development. */
export function validateServerUrl(value: string | null | undefined): ValidationIssue | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }

  if (!SERVER_URL_PATTERN.test(value)) {
    return {
      field: 'serverUrl',
      message:
        'Server URL must use https, or http on localhost, 127.0.0.1 or [::1] ' +
        'for local development. Credentials in the URL and fragments are not ' +
        'allowed.',
    };
  }

  return null;
}

const ajv = new Ajv({ strict: false, allErrors: true });

/**
 * Validates a tool list in the OpenAI function format.
 *
 * Stored unchanged in that format: it is what the customer already knows from
 * Vapi and OpenAI, and what the agent hands the model with no translation. A
 * bespoke shape would be a second thing to learn and a mapping layer to get
 * wrong.
 *
 * Every issue names the offending tool, because "invalid tool list" against
 * twelve tools tells the customer nothing about which one to fix.
 */
export function validateTools(value: unknown): ValidationIssue[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [{ field: 'tools', message: 'Tools must be a list.' }];
  }

  const issues: ValidationIssue[] = [];

  value.forEach((tool, index) => {
    const label = `tool ${index + 1}`;

    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) {
      issues.push({ field: 'tools', message: `${label} is not an object.` });
      return;
    }

    const { name, description, parameters } = tool as Record<string, unknown>;
    const named =
      typeof name === 'string' && name !== '' ? `"${name}"` : label;

    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
      issues.push({
        field: 'tools',
        message: `${label} needs a name of 1 to 64 letters, digits, underscores or hyphens.`,
      });
    }

    if (typeof description !== 'string' || description.trim() === '') {
      issues.push({
        field: 'tools',
        message: `${named} needs a description. The model chooses a tool by reading it.`,
      });
    }

    if (
      typeof parameters !== 'object' ||
      parameters === null ||
      Array.isArray(parameters)
    ) {
      issues.push({
        field: 'tools',
        message: `${named} needs a parameters object.`,
      });
      return;
    }

    if ((parameters as Record<string, unknown>).type !== 'object') {
      issues.push({
        field: 'tools',
        message: `${named}: parameters must have "type": "object".`,
      });
      return;
    }

    // Compiling is the operational definition of "valid JSON Schema" — two
    // implementations can disagree about the phrase, but not about whether
    // Ajv accepted it.
    try {
      ajv.compile(parameters as object);
    } catch (error) {
      issues.push({
        field: 'tools',
        message: `${named}: parameters is not valid JSON Schema — ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  });

  return issues;
}
