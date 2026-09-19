/**
 * The server-URL matrix, in one place.
 *
 * It is shared rather than duplicated because it is asserted twice and the two
 * must never drift: once against `validateServerUrl` directly, and once through
 * the real save path in `test/assistant-write-path.test.ts`, where each case is
 * submitted to `createAssistantAction` as form data. A unit test that agrees
 * with a validator nobody calls proves nothing about what gets saved, and two
 * copies of the matrix is how one of them quietly loses the near-miss hosts.
 *
 * The three near-miss hosts are the reason this matrix exists in the shape it
 * does. `localhost.evil.example` and `127.0.0.1.nip.io` both resolve to
 * attacker-controlled addresses while reading like loopback, and `0.0.0.0` is
 * not a loopback address at all despite being routinely mistaken for one. A
 * `startsWith` or `includes` check accepts all three.
 */

export type UrlCase = {
  /** Why this case is in the matrix, printed in the test name. */
  label: string;
  url: string;
};

/** `https:` anywhere, `http:` on loopback. Every one of these must save. */
export const ACCEPTED_SERVER_URLS: readonly UrlCase[] = [
  { label: 'https with a path, a port and a query', url: 'https://hooks.example.invalid:8443/inbound?event=call' },
  { label: 'https with a path', url: 'https://example.invalid/hook' },
  { label: 'loopback http spelled localhost', url: 'http://localhost:3000/hook' },
  { label: 'loopback http spelled 127.0.0.1', url: 'http://127.0.0.1:3000/hook' },
  { label: 'loopback http spelled [::1]', url: 'http://[::1]:3000/hook' },
  { label: 'loopback http with no port or path', url: 'http://127.0.0.1' },
  { label: 'https on localhost', url: 'https://localhost' },
] as const;

/** Every one of these must be refused before anything is written. */
export const REJECTED_SERVER_URLS: readonly UrlCase[] = [
  { label: 'non-loopback http', url: 'http://example.invalid/hook' },
  { label: 'uppercase LOCALHOST', url: 'http://LOCALHOST/hook' },
  { label: 'a host that merely starts with localhost', url: 'http://localhost.evil.example' },
  { label: 'a host that merely starts with 127.0.0.1', url: 'http://127.0.0.1.nip.io' },
  { label: 'a host that merely starts with [::1]', url: 'http://[::1].evil.example' },
  { label: 'the unspecified address 0.0.0.0', url: 'http://0.0.0.0' },
  { label: 'credentials in the userinfo', url: 'https://user:pw@example.invalid/hook' },
  { label: 'a fragment', url: 'https://example.invalid/hook#fragment' },
  { label: 'whitespace inside the path', url: 'https://example.invalid/ho ok' },
  { label: 'leading whitespace', url: ' https://example.invalid/hook' },
  { label: 'a relative URL', url: '/hook' },
  { label: 'an empty authority', url: 'https://:' },
  { label: 'a non-numeric port', url: 'https://host:abc' },
  { label: 'an unterminated IPv6 authority', url: 'https://[garbage' },
] as const;

/**
 * Both halves, for the tests that assert on the matrix as a whole.
 *
 * The contract requires at least seventeen cases; the count is asserted rather
 * than trusted, because a matrix silently shrinking to its easy cases is
 * exactly the failure a hand-maintained list invites.
 */
export const SERVER_URL_MATRIX: readonly (UrlCase & { accepted: boolean })[] = [
  ...ACCEPTED_SERVER_URLS.map((entry) => ({ ...entry, accepted: true })),
  ...REJECTED_SERVER_URLS.map((entry) => ({ ...entry, accepted: false })),
];
