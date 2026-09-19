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

  // The pattern governs scheme and authority; it does not bound the port,
  // because `(?::[0-9]+)?` accepts any run of digits. `https://example.com:99999`
  // and `http://127.0.0.1:65536` both satisfy it and are both rejected outright
  // by `new URL` — so the pattern alone would accept a string the runtime cannot
  // even parse, let alone reach, and the customer would find out with a caller
  // on the line. That is precisely the failure this module exists to move to
  // save time.
  //
  // The pattern is deliberately not widened to cover this: it is reproduced
  // byte-for-byte from the reviewed original and that provenance is worth more
  // than folding one more rule into an already dense regex. The parser is the
  // better authority for "is this a URL at all" anyway.
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return {
      field: 'serverUrl',
      message:
        'Server URL is not a valid URL. A port must be between 1 and 65535.',
    };
  }

  // Port 0 parses, and means "any free port" to something binding a socket. As
  // a destination it is never connectable.
  if (parsed.port === '0') {
    return {
      field: 'serverUrl',
      message: 'Port 0 is not a destination. Use a port between 1 and 65535.',
    };
  }

  return null;
}

/**
 * Used for `validateSchema` only, never `compile`.
 *
 * `compile` **registers** the schema under its `$id`, and a second
 * registration of the same `$id` throws. Each save parses the tool list fresh,
 * so the objects differ and Ajv's identity cache does not absorb it: a
 * customer who includes `$id` — normal, and likely for exactly the people
 * hand-writing JSON Schema — saves once and is then told their schema is
 * invalid on every subsequent save, for the life of the process. The registry
 * is per-instance and this instance is module-level, so one account could burn
 * an `$id` for another.
 *
 * `validateSchema` answers the only question being asked — is this valid JSON
 * Schema — and registers nothing. It also avoids retaining every schema and
 * generated validator ever submitted, which `compile` does through a strong
 * cache that would grow on form input.
 */
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
 *
 * **Names must be unique.** A tool call arrives as a name and nothing else, so
 * two tools called `lookup_order` make the call ambiguous by construction —
 * whatever a given provider does with a list containing both. Rejecting it at
 * save is the only point where the customer can still fix it; the alternative
 * is finding out at call time, with a caller on the line, which is the failure
 * mode this whole module exists to move earlier.
 */
export function validateTools(value: unknown): ValidationIssue[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [{ field: 'tools', message: 'Tools must be a list.' }];
  }

  const issues: ValidationIssue[] = [];
  const seenNames = new Set<string>();
  const duplicated = new Set<string>();

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
    } else if (seenNames.has(name)) {
      // Recorded rather than pushed here, so twelve tools sharing a name
      // produce one issue instead of eleven. Compared exactly: `lookup_order`
      // and `Lookup_Order` are two different identifiers to a provider, and
      // folding case here would reject a list that works.
      duplicated.add(name);
    } else {
      seenNames.add(name);
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

    // Ajv's verdict is the operational definition of "valid JSON Schema" —
    // two implementations can disagree about the phrase, but not about whether
    // Ajv accepted it. `validateSchema`, never `compile`: see the note on the
    // instance above.
    if (!ajv.validateSchema(parameters as object)) {
      const detail = ajv.errors?.[0]?.message ?? 'schema is not valid';

      issues.push({
        field: 'tools',
        message: `${named}: parameters is not valid JSON Schema — ${detail}`,
      });
    }
  });

  for (const name of duplicated) {
    issues.push({
      field: 'tools',
      message: `Two tools are called "${name}". A tool call names one tool, so the names must be unique.`,
    });
  }

  return issues;
}
