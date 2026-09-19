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

  // URL schemes are case-insensitive by specification, and the pattern is
  // written in lower case, so `HTTPS://example.com` was rejected with a message
  // telling the customer to use https — which they had. Only the scheme is
  // folded: a path is case-sensitive and lowercasing the whole string would
  // silently change where the webhook points.
  const normalised = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, (scheme) =>
    scheme.toLowerCase(),
  );

  if (!SERVER_URL_PATTERN.test(normalised)) {
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
    parsed = new URL(normalised);
  } catch {
    // Deliberately does not name a cause. This catches an out-of-range port,
    // a malformed IPv6 literal like `https://[0:0:0:0:0:0:0:0:0:0]`, and
    // anything else the parser refuses — an earlier version said "a port must
    // be between 1 and 65535" for all of them, which is a false statement to
    // put in front of a customer whose URL has no port at all.
    return {
      field: 'serverUrl',
      message:
        'Server URL is not a valid URL. Check the host and, if there is one, ' +
        'that the port is between 1 and 65535.',
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

  // The unspecified addresses. `0.0.0.0` and `::` mean "every interface" to
  // something binding a socket and are not destinations — and `http://0.0.0.0`
  // was already rejected as not-loopback while `https://0.0.0.0` sailed
  // through, which is the two halves of one rule disagreeing.
  if (
    parsed.hostname === '0.0.0.0' ||
    parsed.hostname === '[::]' ||
    parsed.hostname === '::'
  ) {
    return {
      field: 'serverUrl',
      message:
        'That address means "every interface" and is not somewhere a webhook ' +
        'can be delivered. Use the hostname the service answers on.',
    };
  }

  // An empty DNS label — `.example.com` or `example..com`. `new URL` preserves
  // both and they resolve nowhere. A single *trailing* dot is deliberately
  // allowed: `example.com.` is a root-anchored FQDN and resolves correctly, so
  // rejecting it would be the false-rejection-at-save this module exists to
  // prevent.
  if (/^\.|\.\./.test(parsed.hostname)) {
    return {
      field: 'serverUrl',
      message: 'That hostname has an empty part. Check for a stray or doubled dot.',
    };
  }

  return null;
}

/**
 * Is this a valid JSON Schema? Returns the reason if not.
 *
 * Three constraints pull against each other here, and all three have already
 * been got wrong once in this file:
 *
 *  1. **It must not burn `$id`.** A module-level Ajv instance registers each
 *     compiled schema under its `$id`, and a second registration of the same
 *     one throws. Every save parses the tool list fresh, so the objects differ
 *     and Ajv's identity cache does not absorb it: a customer using `$id` —
 *     normal, and likely for the people hand-writing JSON Schema — saved once
 *     and was then told their schema was invalid forever after. The registry is
 *     per-instance, so one account could burn an `$id` for another.
 *  2. **It must still resolve `$ref`.** Switching to `validateSchema` fixed (1)
 *     and silently dropped this: `validateSchema` checks the schema against its
 *     meta-schema and never resolves references, so `{"$ref":
 *     "#/definitions/missing"}` — the most common hand-written mistake there is
 *     — started passing and reaching call time. `compile` resolves, which is
 *     what had been catching it.
 *  3. **It must not throw.** `compile` *and* `validateSchema` both throw on an
 *     unresolvable reference or an unusable `$schema`, and the `try`/`catch`
 *     that used to contain that was dropped along with `compile`, turning
 *     ordinary textarea input into a 500.
 *
 * A **throwaway instance per call** satisfies all three: it resolves refs, it
 * has no cross-save registry to burn, and it is collected. Roughly 1.5 ms per
 * schema, on a path that already does a database write.
 *
 * `$schema` is dropped before compiling. It selects a meta-schema dialect, and
 * Ajv 8 ships draft-07 — so `"$schema": "https://json-schema.org/draft/2020-12/schema"`,
 * which is exactly what a customer copying a schema from anywhere else will
 * have, is not registered and throws. Rejecting a valid 2020-12 schema is a
 * false rejection at save, which is the failure this module exists to prevent,
 * and the field is advisory for a tool's `parameters` anyway — providers ignore
 * it. So it is ignored here too, and everything under it is still validated.
 */
function schemaProblem(parameters: object): string | null {
  const withoutDialect: Record<string, unknown> = {
    ...(parameters as Record<string, unknown>),
  };

  delete withoutDialect.$schema;

  try {
    new Ajv({ strict: false, allErrors: true }).compile(withoutDialect);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'schema is not valid';
  }
}

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
    // Ajv accepted it. See `schemaProblem` for why it compiles on a throwaway
    // instance rather than validating on a shared one.
    const problem = schemaProblem(parameters as object);

    if (problem !== null) {
      issues.push({
        field: 'tools',
        message: `${named}: parameters is not valid JSON Schema — ${problem}`,
      });
    }
  });

  for (const name of duplicated) {
    issues.push({
      field: 'tools',
      message: `Two tools are called "${name}". A tool call names one tool, so the names must be unique.`,
    });
  }

  // Identical messages are collapsed. Every issue above names its tool, so two
  // issues with the same text are two tools with the same name and the same
  // fault — and the customer cannot tell them apart from the text anyway.
  // Showing `"a" needs a description.` twice reads as a rendering bug rather
  // than as two problems.
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.field} ${issue.message}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
