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
  { label: 'a public IPv4 literal', url: 'https://93.184.216.34/hook' },
  { label: 'a public IPv6 literal', url: 'https://[2606:4700:4700::1111]/hook' },
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
 *
 * **Port cases are deliberately not in here.** Every case above is decided by
 * `SERVER_URL_PATTERN` alone, which is what lets one test assert that the
 * pattern and `validateServerUrl` agree on all of them — the check that the
 * recovered regex is the thing actually in use. Ports are decided by a
 * *second* gate that the pattern knows nothing about, so the validator is
 * strictly stronger than the pattern there and the equivalence deliberately
 * does not hold. Folding them in would break that test for a reason that has
 * nothing to do with what it is testing.
 */
export const SERVER_URL_MATRIX: readonly (UrlCase & { accepted: boolean })[] = [
  ...ACCEPTED_SERVER_URLS.map((entry) => ({ ...entry, accepted: true })),
  ...REJECTED_SERVER_URLS.map((entry) => ({ ...entry, accepted: false })),
];

/**
 * Ports, judged by the second gate rather than by the pattern.
 *
 * `(?::[0-9]+)?` accepts any run of digits, so the pattern says yes to
 * `:65536` and `:99999` — strings `new URL` refuses to parse at all, which
 * means the customer would have saved a webhook the runtime cannot even
 * construct and found out with a caller on the line. Port `0` is the
 * subtler one: it parses cleanly and means "any free port" to something
 * binding a socket, so it is never a destination.
 */
export const REJECTED_PORTS: readonly UrlCase[] = [
  { label: 'one past the maximum port', url: 'http://127.0.0.1:65536/hook' },
  { label: 'a wildly out-of-range port', url: 'https://example.invalid:99999/hook' },
  { label: 'port zero, which parses but is not a destination', url: 'https://example.invalid:0/hook' },
  { label: 'port zero on loopback', url: 'http://localhost:0/hook' },
] as const;

/** Ports that are genuine destinations and must keep saving. */
export const ACCEPTED_PORTS: readonly UrlCase[] = [
  { label: 'a common TLS port', url: 'https://example.invalid:8443/hook' },
  { label: 'the lowest usable port', url: 'https://example.invalid:1/hook' },
  { label: 'the highest usable port', url: 'https://example.invalid:65535/hook' },
  { label: 'no port at all', url: 'https://example.invalid/hook' },
] as const;

/**
 * Loopback, which now needs `ALLOW_LOOPBACK_SERVER_URL=true`.
 *
 * These were unconditionally accepted, which meant **production** accepted
 * them too — a webhook pointing at `localhost` from the platform's own network
 * reaches the platform, not the customer. The dev exception is still available,
 * behind a flag that is off unless a deployment says otherwise.
 *
 * `https://localhost` is in here rather than in the accepted list, and that is
 * a decision rather than an oversight. RFC 6761 reserves the name to loopback,
 * so treating it as an unresolved hostname would be pretending not to know
 * something the standard guarantees — and `https://localhost` accepted while
 * `https://127.0.0.1` is refused is the same machine answering to two rules,
 * which is exactly the split that made `http://0.0.0.0` rejected while
 * `https://0.0.0.0` sailed through.
 */
export const FLAG_GATED_LOOPBACK: readonly UrlCase[] = [
  { label: 'loopback http spelled localhost', url: 'http://localhost:3000/hook' },
  { label: 'loopback http spelled 127.0.0.1', url: 'http://127.0.0.1:3000/hook' },
  { label: 'loopback http spelled [::1]', url: 'http://[::1]:3000/hook' },
  { label: 'loopback http with no port or path', url: 'http://127.0.0.1' },
  { label: 'https on localhost', url: 'https://localhost' },
  { label: 'https on localhost with a port', url: 'https://localhost:8443/hook' },
] as const;

/**
 * Addresses inside the platform's own network. Refused **whatever the flag
 * says** — the flag exempts loopback and nothing else.
 *
 * The headline is not the dev exception: `https://169.254.169.254` is the
 * cloud instance metadata endpoint on every major provider, it was accepted
 * outright before this rule, and reaching it from a server-side fetch is the
 * classic way credentials walk out of a deployment.
 */
export const REJECTED_PRIVATE_ADDRESSES: readonly UrlCase[] = [
  { label: 'RFC1918 10/8', url: 'https://10.0.0.5/hook' },
  { label: 'RFC1918 172.16/12 at its lower bound', url: 'https://172.16.0.1/hook' },
  { label: 'RFC1918 172.16/12 at its upper bound', url: 'https://172.31.255.254/hook' },
  { label: 'RFC1918 192.168/16', url: 'https://192.168.1.10/hook' },
  { label: 'the cloud metadata endpoint', url: 'https://169.254.169.254/latest/meta-data/' },
  { label: 'IPv6 unique-local', url: 'https://[fd00::1]/hook' },
  { label: 'IPv6 link-local', url: 'https://[fe80::1]/hook' },
] as const;

/**
 * Just outside every boundary, and public. **These are what make the rejections
 * above mean something**: a mutation that deleted the range check entirely and
 * one that widened it by a single octet produce identical output against the
 * rejected list alone. Only a control that must stay accepted tells them apart.
 */
export const PUBLIC_BOUNDARY_CONTROLS: readonly UrlCase[] = [
  { label: 'one below 10/8', url: 'https://9.255.255.255/hook' },
  { label: 'one above 10/8', url: 'https://11.0.0.5/hook' },
  { label: 'one below 172.16/12', url: 'https://172.15.0.1/hook' },
  { label: 'one above 172.16/12', url: 'https://172.32.0.1/hook' },
  { label: 'one below 192.168/16', url: 'https://192.167.1.1/hook' },
  { label: 'one above 192.168/16', url: 'https://192.169.1.1/hook' },
  { label: 'one below 169.254/16', url: 'https://169.253.0.1/hook' },
  { label: 'one above 169.254/16', url: 'https://169.255.0.1/hook' },
  { label: 'a public IPv6 literal', url: 'https://[2606:4700:4700::1111]/hook' },
  { label: 'just below the unique-local block', url: 'https://[fb00::1]/hook' },
  { label: 'just below the link-local block', url: 'https://[fe00::1]/hook' },
  { label: 'NAT64 wrapping a public address', url: 'https://[64:ff9b::808:808]/hook' },
  { label: '6to4 wrapping a public address', url: 'https://[2002:b00:5::]/hook' },
  { label: 'IPv4-mapped wrapping a public address', url: 'https://[::ffff:b00:5]/hook' },
] as const;

/**
 * An IPv4 address wearing an IPv6 spelling.
 *
 * Three transition formats put a v4 address inside a v6 one, and all three
 * reach the same machine the dotted spelling does. `new URL` normalises
 * IPv4-mapped addresses to **hex** — `::ffff:10.0.0.5` becomes `::ffff:a00:5`
 * — so a check written against the dotted form never fires on what the parser
 * actually produces, while the dotted form itself is refused by the *pattern*
 * for an unrelated reason. Right answer, wrong rule, reads as coverage.
 *
 * **These are judged by unwrapping, not by refusing the prefix.** Blanket
 * rejection would be a bug of its own: `64:ff9b::<public v4>` is how an
 * IPv6-only network legitimately reaches the IPv4 internet, so refusing the
 * prefix wholesale turns away real targets — the false-rejection-at-save this
 * module exists to prevent. What makes an address unacceptable is the machine
 * it reaches, never the spelling.
 *
 * The matching accepts live in `PUBLIC_BOUNDARY_CONTROLS`, and they are
 * load-bearing: against this list alone, "unwraps and range-checks" and
 * "rejects every transition format" are indistinguishable.
 */
export const REJECTED_TRANSITION_FORMATS: readonly UrlCase[] = [
  { label: 'IPv4-mapped, the metadata endpoint', url: 'https://[::ffff:a9fe:a9fe]/hook' },
  { label: 'IPv4-mapped loopback', url: 'https://[::ffff:7f00:1]/hook' },
  { label: 'IPv4-mapped RFC1918 10.0.0.5', url: 'https://[::ffff:a00:5]/hook' },
  { label: 'IPv4-mapped RFC1918 192.168.0.1', url: 'https://[::ffff:c0a8:1]/hook' },
  { label: 'IPv4-mapped, fully expanded', url: 'https://[0:0:0:0:0:ffff:a00:5]/hook' },
  { label: '6to4 wrapping RFC1918 10.0.0.5', url: 'https://[2002:a00:5::]/hook' },
  { label: '6to4 wrapping loopback', url: 'https://[2002:7f00:1::]/hook' },
  { label: '6to4 wrapping the metadata endpoint', url: 'https://[2002:a9fe:a9fe::]/hook' },
  { label: 'NAT64 wrapping RFC1918 10.0.0.5', url: 'https://[64:ff9b::a00:5]/hook' },
  { label: 'NAT64 wrapping the metadata endpoint', url: 'https://[64:ff9b::a9fe:a9fe]/hook' },
] as const;
