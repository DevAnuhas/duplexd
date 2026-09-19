import { describe, expect, it } from 'vitest';

import { SERVER_URL_PATTERN, validateServerUrl } from '@/lib/validate';

import {
  ACCEPTED_SERVER_URLS,
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
