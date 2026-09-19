import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVER_URL_PATTERN, validateServerUrl } from '@/lib/validate';

import {
  ACCEPTED_PORTS,
  FLAG_GATED_LOOPBACK,
  PUBLIC_BOUNDARY_CONTROLS,
  REJECTED_PRIVATE_ADDRESSES,
  ACCEPTED_SERVER_URLS,
  REJECTED_PORTS,
  REJECTED_SERVER_URLS,
  SERVER_URL_MATRIX,
} from './helpers/server-urls.ts';

/**
 * Where a customer's webhook may point.
 *
 * `https:` anywhere, `http:` only on loopback for local development. The
 * interesting half is not the obvious rejections — it is the hosts that read
 * like loopback and are not: `localhost.evil.example` and `127.0.0.1.nip.io`
 * resolve wherever their owner points them, and `0.0.0.0` is the unspecified
 * address rather than a loopback one. A check written with `startsWith` or
 * `includes` accepts all three and looks entirely reasonable in review.
 *
 * The same matrix is submitted through the real save path in
 * `test/assistant-write-path.test.ts`. This file is the unit half; that file is
 * the half that proves the validator is actually reached before a write.
 */

describe('the server URL matrix', () => {
  /**
   * The contract requires at least seventeen cases. Asserted rather than
   * trusted: a matrix that quietly loses its awkward cases still prints green.
   */
  it('covers at least the seventeen cases the contract requires', () => {
    expect(SERVER_URL_MATRIX.length).toBeGreaterThanOrEqual(17);
    expect(ACCEPTED_SERVER_URLS.length).toBeGreaterThan(0);
    expect(REJECTED_SERVER_URLS.length).toBeGreaterThan(0);
  });

  it('has no duplicate cases', () => {
    const urls = SERVER_URL_MATRIX.map((entry) => entry.url);

    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('validateServerUrl accepts', () => {
  it.each(ACCEPTED_SERVER_URLS.map((entry) => [entry.label, entry.url]))(
    '%s — %s',
    (_label, url) => {
      expect(validateServerUrl(url)).toBeNull();
    },
  );
});

describe('validateServerUrl rejects', () => {
  it.each(REJECTED_SERVER_URLS.map((entry) => [entry.label, entry.url]))(
    '%s — %s',
    (_label, url) => {
      const issue = validateServerUrl(url);

      expect(issue, `${url} was accepted`).not.toBeNull();
      expect(issue?.field).toBe('serverUrl');
      expect(issue?.message).not.toBe('');

      // **And rejected by the pattern specifically.**
      //
      // `validateServerUrl` grew a second gate — `new URL` — and four of these
      // cases (`/hook`, `https://:`, `https://host:abc`, `https://[garbage`)
      // are strings the parser also refuses. Without this line those four
      // would keep passing if the pattern stopped rejecting them, because the
      // parser would quietly cover for it: the assertion says "rejected" and
      // stops caring why.
      //
      // Measured, not supposed: neutering the pattern to `/^[\s\S]*$/` left
      // exactly those four green before this line existed. Every case in the
      // matrix is a pattern decision, so pinning it here keeps each case
      // self-contained rather than leaning on a sibling test to notice.
      expect(
        SERVER_URL_PATTERN.test(url),
        `${url} is no longer rejected by the pattern — only by the parser`,
      ).toBe(false);
    },
  );
});

/**
 * An assistant does not have to call a webhook at all, so "no URL" is not an
 * error. This is separated from the matrix because it is a different question:
 * the matrix is about which URLs are allowed, this is about the field being
 * optional.
 */
describe('an absent server URL', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['the empty string', ''],
    ['only whitespace', '   '],
  ])('is not an error when it is %s', (_label, value) => {
    expect(validateServerUrl(value)).toBeNull();
  });
});

/**
 * The pattern is exported and asserted directly as well as through the
 * function, because the contract requires the recovered regex to be the thing
 * in use. A rewrite that happened to agree on this matrix would still be a
 * change the PR body has to declare.
 */
describe('the exported pattern', () => {
  it('is the one the validator uses, on every case in the matrix', () => {
    // Guarded here rather than relying on the count test above. A loop whose
    // collection is empty passes every assertion inside it, so a matrix that
    // shrank to nothing would leave this test green while checking no URL at
    // all — and a cross-test guarantee is not a guarantee, because either test
    // can be deleted without the other noticing.
    expect(SERVER_URL_MATRIX.length).toBeGreaterThanOrEqual(17);

    for (const { url, accepted } of SERVER_URL_MATRIX) {
      expect(SERVER_URL_PATTERN.test(url), `pattern disagrees on ${url}`).toBe(
        accepted,
      );
      expect(validateServerUrl(url) === null, `validator disagrees on ${url}`).toBe(
        accepted,
      );
    }
  });

  /**
   * A global regex carries `lastIndex` between calls, so the second `test` of
   * the same string returns false. It would make the validator accept a URL it
   * had just rejected, intermittently, depending on call order.
   */
  it('is not global or sticky, so repeated calls agree', () => {
    expect(SERVER_URL_PATTERN.global).toBe(false);
    expect(SERVER_URL_PATTERN.sticky).toBe(false);

    const url = ACCEPTED_SERVER_URLS[0]?.url ?? '';

    expect(validateServerUrl(url)).toBeNull();
    expect(validateServerUrl(url)).toBeNull();
    expect(validateServerUrl(url)).toBeNull();
  });
});

/**
 * Port bounds, which the pattern does not govern.
 *
 * `(?::[0-9]+)?` accepts any run of digits, so `https://example.invalid:99999`
 * satisfies the pattern and is still a string `new URL` refuses to parse. A
 * validator whose whole thesis is "rejected at save, never at call time" was
 * accepting a webhook the runtime cannot construct — statically knowable, and
 * discovered with a caller on the line.
 */
describe('port bounds', () => {
  it.each(REJECTED_PORTS.map((entry) => [entry.label, entry.url]))(
    'rejects %s — %s',
    (_label, url) => {
      const issue = validateServerUrl(url);

      expect(issue, `${url} was accepted`).not.toBeNull();
      expect(issue?.field).toBe('serverUrl');
    },
  );

  it.each(ACCEPTED_PORTS.map((entry) => [entry.label, entry.url]))(
    'accepts %s — %s',
    (_label, url) => {
      expect(validateServerUrl(url)).toBeNull();
    },
  );

  /**
   * **The test that proves the second gate is what does this work.**
   *
   * Every port above is *accepted* by `SERVER_URL_PATTERN` and rejected by
   * `validateServerUrl`, so the two deliberately disagree here. That makes this
   * the one assertion that goes red if the parser check is removed — the
   * `it.each` above would too, but this one also fails if somebody "fixes" it
   * by widening the regex instead, which the module explicitly does not want:
   * the pattern's provenance from the reviewed original is worth more than
   * another clause in it.
   */
  it('rejects them at the parser, not at the pattern', () => {
    const outOfRange = REJECTED_PORTS.filter((entry) => !entry.url.includes(':0/'));

    expect(outOfRange.length).toBeGreaterThan(0);

    for (const { url } of outOfRange) {
      expect(
        SERVER_URL_PATTERN.test(url),
        `${url} is now rejected by the pattern — the regex was widened, and its ` +
          'byte-for-byte provenance from the reviewed original is gone',
      ).toBe(true);

      expect(
        validateServerUrl(url),
        `${url} reached the parser check and was not rejected`,
      ).not.toBeNull();
    }
  });

  /**
   * Port 0 is the one that parses. It is rejected by an explicit rule rather
   * than by the parser throwing, so it is pinned separately — a fix that only
   * caught parse failures would let it through.
   */
  it('rejects port zero even though it parses cleanly', () => {
    expect(() => new URL('https://example.invalid:0/hook')).not.toThrow();
    expect(validateServerUrl('https://example.invalid:0/hook')).not.toBeNull();
  });
});

/**
 * Which rule turned a URL away.
 *
 * Two independent rules can refuse the same input — the scheme rule and the
 * private-range rule both reject `http://127.0.0.1` with the flag off — and an
 * assertion that only says "rejected" passes for either, so one of them can rot
 * silently. That is the masking shape that let four cases in the matrix start
 * riding on `new URL` instead of the pattern. The messages are deliberately
 * distinguishable, so the tests below name the rule.
 */
function rejectionRule(url: string): string {
  const issue = validateServerUrl(url);

  if (issue === null) {
    return 'accepted';
  }
  if (/must use https/.test(issue.message)) {
    return 'scheme';
  }
  if (/every interface/.test(issue.message)) {
    return 'unspecified';
  }
  if (/platform's own/.test(issue.message)) {
    return 'range';
  }
  if (/Port 0/.test(issue.message)) {
    return 'port-zero';
  }
  if (/not a valid URL/.test(issue.message)) {
    return 'parse';
  }

  return 'other';
}

/** The flag is read from the environment on every call, so it can be toggled. */
function allowLoopback(allowed: boolean): void {
  vi.stubEnv('ALLOW_LOOPBACK_SERVER_URL', allowed ? 'true' : '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Loopback behind `ALLOW_LOOPBACK_SERVER_URL`.
 *
 * It used to be accepted unconditionally, which meant production accepted it —
 * a webhook pointing at `localhost` is called from the platform's network and
 * reaches the platform, not the customer.
 */
describe('the loopback development flag', () => {
  it.each(FLAG_GATED_LOOPBACK.map((entry) => [entry.label, entry.url]))(
    'accepts %s with the flag on — %s',
    (_label, url) => {
      allowLoopback(true);

      expect(validateServerUrl(url), `${url} was refused with the flag on`).toBeNull();
    },
  );

  /**
   * Named by rule, not merely "rejected". With the flag off these are refused
   * by the range rule; if a future change made the flag inert, an assertion
   * that only checked for rejection would keep passing on the scheme rule for
   * the `http:` ones and nobody would learn the flag had stopped working.
   */
  it.each(FLAG_GATED_LOOPBACK.map((entry) => [entry.label, entry.url]))(
    'refuses %s with the flag off, by the range rule — %s',
    (_label, url) => {
      allowLoopback(false);

      expect(rejectionRule(url), `${url} was not refused as a private address`).toBe(
        'range',
      );
    },
  );

  /** The flag is an exemption for loopback, not a general loosening. */
  it('does not accept non-loopback http even with the flag on', () => {
    allowLoopback(true);

    expect(rejectionRule('http://example.invalid/hook')).toBe('scheme');
  });

  it('does not accept other private ranges even with the flag on', () => {
    allowLoopback(true);

    expect(rejectionRule('https://10.0.0.5/hook')).toBe('range');
    expect(rejectionRule('https://169.254.169.254/latest/meta-data/')).toBe('range');
  });

  it('treats any value other than "true" as off', () => {
    for (const value of ['', 'false', '1', 'yes', 'TRUE']) {
      vi.stubEnv('ALLOW_LOOPBACK_SERVER_URL', value);

      expect(
        rejectionRule('http://localhost:3000/hook'),
        `"${value}" was treated as enabling loopback`,
      ).toBe('range');
    }
  });
});

/**
 * The headline of this rule, and it is not the dev exception.
 *
 * `https://169.254.169.254/latest/meta-data/` was accepted outright before
 * this — the cloud instance metadata endpoint on every major provider, reached
 * from the platform's own network with the platform's own credentials.
 */
describe('addresses inside the platform’s network', () => {
  it.each(REJECTED_PRIVATE_ADDRESSES.map((entry) => [entry.label, entry.url]))(
    'refuses %s by the range rule — %s',
    (_label, url) => {
      allowLoopback(false);

      expect(rejectionRule(url), `${url} was accepted`).toBe('range');
    },
  );

  it.each(REJECTED_PRIVATE_ADDRESSES.map((entry) => [entry.label, entry.url]))(
    'still refuses %s with the flag on — %s',
    (_label, url) => {
      allowLoopback(true);

      expect(rejectionRule(url), `the flag exempted ${url}`).toBe('range');
    },
  );

  /**
   * The controls that make the rejections mean something. Deleting the range
   * check and widening it by one octet produce identical output against the
   * rejected list alone; only these tell them apart.
   */
  it.each(PUBLIC_BOUNDARY_CONTROLS.map((entry) => [entry.label, entry.url]))(
    'still accepts %s — %s',
    (_label, url) => {
      allowLoopback(false);

      expect(
        validateServerUrl(url),
        `${url} is public and was refused — the range check is too wide`,
      ).toBeNull();
    },
  );

  /**
   * Alternate spellings of the same address. `new URL` normalises decimal,
   * hexadecimal, octal and short-form IPv4 to dotted quads, and the validator
   * reads the **parsed** hostname rather than the raw string — so these are
   * caught for free. Pinned because reading the raw string instead would be an
   * easy and invisible regression.
   */
  it.each([
    ['decimal', 'https://2130706433/hook'],
    ['hexadecimal', 'https://0x7f000001/hook'],
    ['octal', 'https://0177.0.0.1/hook'],
    ['short form', 'https://127.1/hook'],
  ])('refuses 127.0.0.1 written in %s — %s', (_label, url) => {
    allowLoopback(false);

    expect(rejectionRule(url), `${url} bypassed the range check`).toBe('range');
  });

  it('refuses 10.0.0.5 written in decimal', () => {
    allowLoopback(false);

    expect(rejectionRule('https://167772165/hook')).toBe('range');
  });
});

/**
 * **Currently red. An IPv4 address wearing an IPv6 spelling bypasses the range
 * check, including the cloud metadata endpoint.**
 *
 * `privateAddressReason` has a branch for exactly this — it matches
 * `^::ffff:(.+)$` and feeds the remainder to `ipv4Octets`. That branch never
 * fires, because it expects the **dotted** form `::ffff:10.0.0.5`, and
 * `new URL` normalises IPv4-mapped addresses to **hex**: `::ffff:a00:5`.
 * `ipv4Octets` returns null on that, the code falls through to the plain IPv6
 * checks, none of which match, and the address is accepted.
 *
 * The dotted form is refused, which is what hides it — but by the *scheme*
 * rule, not the range rule, because the pattern's IPv6 class is
 * `[0-9a-fA-F:]+` and rejects the dots. So the one spelling anybody would
 * test by hand is turned away for an unrelated reason while the spelling the
 * parser actually produces sails through.
 *
 * Measured on `96b16f2`:
 *
 *     ACCEPT  host=[::ffff:a9fe:a9fe]  https://[::ffff:a9fe:a9fe]/hook   <- 169.254.169.254
 *     ACCEPT  host=[::ffff:7f00:1]     https://[::ffff:7f00:1]/hook      <- 127.0.0.1
 *     ACCEPT  host=[::ffff:a00:5]      https://[::ffff:a00:5]/hook       <- 10.0.0.5
 *
 * This is the hole the rule was added to close, still open under a different
 * spelling of the same address.
 */
describe('IPv4-mapped IPv6 addresses', () => {
  it.each([
    ['the cloud metadata endpoint as ::ffff:a9fe:a9fe', 'https://[::ffff:a9fe:a9fe]/hook'],
    ['loopback as ::ffff:7f00:1', 'https://[::ffff:7f00:1]/hook'],
    ['RFC1918 10.0.0.5 as ::ffff:a00:5', 'https://[::ffff:a00:5]/hook'],
    ['RFC1918 192.168.0.1 as ::ffff:c0a8:1', 'https://[::ffff:c0a8:1]/hook'],
    ['10.0.0.5 fully expanded', 'https://[0:0:0:0:0:ffff:a00:5]/hook'],
  ])('refuses %s — %s', (_label, url) => {
    allowLoopback(false);

    expect(
      rejectionRule(url),
      `${url} reaches the same machine as its dotted spelling and was accepted`,
    ).toBe('range');
  });

  /**
   * The control, and the reason this is a bug rather than a scope question:
   * the dotted spelling *is* refused, so the intent is not in doubt — only the
   * spelling the URL parser actually hands the validator was missed.
   */
  it('already refuses the dotted spelling, so the intent is clear', () => {
    allowLoopback(false);

    expect(validateServerUrl('https://[::ffff:10.0.0.5]/hook')).not.toBeNull();
  });
});
