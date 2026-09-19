import { describe, expect, it } from 'vitest';

import { SERVER_URL_PATTERN, validateServerUrl } from '@/lib/validate';

import {
  ACCEPTED_PORTS,
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
