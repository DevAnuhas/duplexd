import { afterEach, describe, expect, it } from 'vitest';

import {
  SIGNATURE_TOLERANCE_SECONDS,
  signHandlerRequest,
  verifyHandlerSignature,
} from '@duplexd/contracts';

import { loadSigningFixture, SYNTHETIC_TEST_SECRET } from './support/fixtures.js';

const fixture = loadSigningFixture();
const vector = fixture.vectors[0];
if (vector === undefined) throw new Error('fixtures/signing.json has no vectors');

const at = (seconds: number) => () => seconds * 1000;
const realVerify = crypto.subtle.verify;

function replaceSubtleVerify(implementation: typeof crypto.subtle.verify | undefined): void {
  Object.defineProperty(crypto.subtle, 'verify', {
    configurable: true,
    writable: true,
    value: implementation ?? realVerify,
  });
}

afterEach(() => replaceSubtleVerify(undefined));

describe('signHandlerRequest', () => {
  it('reproduces the committed vector byte for byte', async () => {
    const header = await signHandlerRequest(vector.secret, vector.body, at(vector.timestamp));
    expect(header).toBe(vector.header);
  });

  it('emits t=<unix seconds>,v1=<lowercase hex> and nothing else', async () => {
    const header = await signHandlerRequest(SYNTHETIC_TEST_SECRET, '{"a":1}', at(1_700_000_000));
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header).not.toMatch(/[A-F]/);
    expect(header.startsWith(`t=${1_700_000_000},`)).toBe(true);
  });

  it('floors the injected clock to whole seconds', async () => {
    const header = await signHandlerRequest(SYNTHETIC_TEST_SECRET, '{}', () => 1_700_000_000_999);
    expect(header.startsWith('t=1700000000,')).toBe(true);
  });

  it('defaults to the real clock when none is injected', async () => {
    const before = Math.floor(Date.now() / 1000);
    const header = await signHandlerRequest(SYNTHETIC_TEST_SECRET, '{}');
    const after = Math.floor(Date.now() / 1000);
    const timestamp = Number(/^t=(\d+),/.exec(header)?.[1]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('signs "<t>.<raw body>" rather than a normalized form', async () => {
    // Two bodies that parse to the same JSON must produce different signatures;
    // if either side reparsed or re-serialized, they would collide.
    const compact = '{"a":1,"b":2}';
    const spaced = '{ "b": 2, "a": 1 }';
    const clock = at(vector.timestamp);
    expect(await signHandlerRequest(SYNTHETIC_TEST_SECRET, compact, clock)).not.toBe(
      await signHandlerRequest(SYNTHETIC_TEST_SECRET, spaced, clock),
    );

    const header = await signHandlerRequest(SYNTHETIC_TEST_SECRET, compact, clock);
    const options = { now: clock, toleranceSeconds: SIGNATURE_TOLERANCE_SECONDS };
    expect(await verifyHandlerSignature(SYNTHETIC_TEST_SECRET, header, compact, options)).toEqual({
      ok: true,
    });
    expect(await verifyHandlerSignature(SYNTHETIC_TEST_SECRET, header, spaced, options)).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
  });

  it('signs an empty body without special-casing it', async () => {
    const header = await signHandlerRequest(SYNTHETIC_TEST_SECRET, '', at(vector.timestamp));
    expect(
      await verifyHandlerSignature(SYNTHETIC_TEST_SECRET, header, '', { now: at(vector.timestamp) }),
    ).toEqual({ ok: true });
  });
});

describe('verifyHandlerSignature accepts', () => {
  const clock = at(vector.timestamp);

  it('the committed vector', async () => {
    expect(await verifyHandlerSignature(vector.secret, vector.header, vector.body, { now: clock }))
      .toEqual({ ok: true });
  });

  it.each([
    ['exactly the tolerance in the past', SIGNATURE_TOLERANCE_SECONDS],
    ['exactly the tolerance in the future', -SIGNATURE_TOLERANCE_SECONDS],
    ['one second inside the past bound', SIGNATURE_TOLERANCE_SECONDS - 1],
    ['one second inside the future bound', -(SIGNATURE_TOLERANCE_SECONDS - 1)],
  ])('a timestamp %s', async (_label, drift) => {
    expect(
      await verifyHandlerSignature(vector.secret, vector.header, vector.body, {
        now: at(vector.timestamp + drift),
      }),
    ).toEqual({ ok: true });
  });

  it('a custom tolerance', async () => {
    expect(
      await verifyHandlerSignature(vector.secret, vector.header, vector.body, {
        now: at(vector.timestamp + 10),
        toleranceSeconds: 10,
      }),
    ).toEqual({ ok: true });
    expect(
      await verifyHandlerSignature(vector.secret, vector.header, vector.body, {
        now: at(vector.timestamp + 11),
        toleranceSeconds: 10,
      }),
    ).toEqual({ ok: false, code: 'stale_timestamp' });
  });
});

describe('verifyHandlerSignature reports stale_timestamp', () => {
  it.each([
    ['one second past the tolerance', SIGNATURE_TOLERANCE_SECONDS + 1],
    ['one second before the tolerance', -(SIGNATURE_TOLERANCE_SECONDS + 1)],
    ['ten minutes stale', 600],
  ])('for a valid signature %s', async (_label, drift) => {
    expect(
      await verifyHandlerSignature(vector.secret, vector.header, vector.body, {
        now: at(vector.timestamp + drift),
      }),
    ).toEqual({ ok: false, code: 'stale_timestamp' });
  });
});

describe('verifyHandlerSignature reports invalid_signature', () => {
  const clock = at(vector.timestamp);
  const verify = (header: string | null, body = vector.body, secret = vector.secret) =>
    verifyHandlerSignature(secret, header, body, { now: clock });

  it.each([
    ['a null header', null],
    ['an empty header', ''],
    ['a header with no t', `v1=${'a'.repeat(64)}`],
    ['a header with no v1', 't=1700000000'],
    ['reversed parts', `v1=${'a'.repeat(64)},t=1700000000`],
    ['a non-numeric timestamp', `t=abc,v1=${'a'.repeat(64)}`],
    ['a negative timestamp', `t=-1,v1=${'a'.repeat(64)}`],
    ['uppercase hex', `t=1700000000,v1=${'A'.repeat(64)}`],
    ['short hex', `t=1700000000,v1=${'a'.repeat(63)}`],
    ['long hex', `t=1700000000,v1=${'a'.repeat(65)}`],
    ['non-hex characters', `t=1700000000,v1=${'z'.repeat(64)}`],
    ['trailing junk', `t=1700000000,v1=${'a'.repeat(64)};extra`],
    ['leading whitespace', ` t=1700000000,v1=${'a'.repeat(64)}`],
    ['an unsafe integer timestamp', `t=${'9'.repeat(20)},v1=${'a'.repeat(64)}`],
  ])('for %s', async (_label, header) => {
    expect(await verify(header as string | null)).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
  });

  it('for a well-formed but wrong signature', async () => {
    expect(await verify(`t=${vector.timestamp},v1=${'0'.repeat(64)}`)).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
  });

  it('for a tampered body', async () => {
    expect(await verify(vector.header, `${vector.body} `)).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
  });

  it('for a tampered timestamp', async () => {
    const [, hex] = /^t=\d+,v1=([0-9a-f]{64})$/.exec(vector.header) ?? [];
    expect(await verify(`t=${vector.timestamp + 1},v1=${hex}`)).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
  });

  it('for the wrong secret', async () => {
    expect(await verify(vector.header, vector.body, `${vector.secret}-wrong`)).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
  });

  it('when key import itself fails', async () => {
    // An empty HMAC key is rejected by WebCrypto; the helper must translate
    // that into the same opaque code rather than throwing at the caller.
    expect(await verify(vector.header, vector.body, '')).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
  });

  it('when the underlying verify call throws', async () => {
    replaceSubtleVerify((async () => {
      throw new Error('crypto exploded');
    }) as typeof crypto.subtle.verify);
    expect(await verify(vector.header)).toEqual({ ok: false, code: 'invalid_signature' });
  });
});

describe('the tampered fixture vectors', () => {
  const clock = at(vector.timestamp);
  const stale = at(vector.timestamp + SIGNATURE_TOLERANCE_SECONDS + 60);

  const mutate = (kind: string): { header: string; body: string; now: () => number } => {
    const [, hex] = /^t=\d+,v1=([0-9a-f]{64})$/.exec(vector.header) ?? [];
    switch (kind) {
      case 'body':
        return { header: vector.header, body: `${vector.body} `, now: clock };
      case 'timestamp':
        return { header: `t=${vector.timestamp + 1},v1=${hex}`, body: vector.body, now: clock };
      case 'signature':
        return { header: `t=${vector.timestamp},v1=${'0'.repeat(64)}`, body: vector.body, now: clock };
      case 'body_and_stale':
        return { header: vector.header, body: `${vector.body} `, now: stale };
      default:
        throw new Error(`unknown mutation: ${kind}`);
    }
  };

  it('cover every mutation the fixture declares', () => {
    expect(fixture.tampered.map((entry) => entry.mutate).sort()).toEqual([
      'body',
      'body_and_stale',
      'signature',
      'timestamp',
    ]);
  });

  it.each(fixture.tampered)('$mutate produces $expectCode', async ({ base, mutate: kind, expectCode }) => {
    const source = fixture.vectors[base];
    expect(source).toBeDefined();
    const { header, body, now } = mutate(kind);
    expect(await verifyHandlerSignature(vector.secret, header, body, { now })).toEqual({
      ok: false,
      code: expectCode,
    });
  });

  it('prefers invalid_signature when a request is both tampered and stale', async () => {
    // Tolerance is only consulted once the bytes have proven themselves, so a
    // caller never learns which half of the check failed first.
    const { header, body } = mutate('body_and_stale');
    expect(await verifyHandlerSignature(vector.secret, header, body, { now: stale })).toEqual({
      ok: false,
      code: 'invalid_signature',
    });
    // The same timestamp with untampered bytes is merely stale.
    expect(await verifyHandlerSignature(vector.secret, vector.header, vector.body, { now: stale }))
      .toEqual({ ok: false, code: 'stale_timestamp' });
  });
});

describe('cryptographic verification is delegated to subtle.verify', () => {
  const clock = at(vector.timestamp);

  it('calls subtle.verify exactly once with HMAC over "<t>.<body>"', async () => {
    const calls: Array<{ algorithm: unknown; signature: Uint8Array; data: Uint8Array }> = [];
    replaceSubtleVerify((async (algorithm, key, signature, data) => {
      calls.push({
        algorithm,
        signature: new Uint8Array(signature as ArrayBuffer),
        data: new Uint8Array(data as ArrayBuffer),
      });
      return realVerify.call(crypto.subtle, algorithm, key, signature, data);
    }) as typeof crypto.subtle.verify);

    expect(await verifyHandlerSignature(vector.secret, vector.header, vector.body, { now: clock }))
      .toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.algorithm).toBe('HMAC');
    expect(call?.signature.byteLength).toBe(32);
    expect(new TextDecoder().decode(call?.data)).toBe(`${vector.timestamp}.${vector.body}`);
  });

  it('lets the boolean result decide the outcome, both ways', async () => {
    // Forcing `false` must reject a genuinely valid signature, and forcing
    // `true` must accept a garbage one. A hand-rolled comparison alongside the
    // call, or ignoring its result, fails one of these.
    replaceSubtleVerify((async () => false) as typeof crypto.subtle.verify);
    expect(await verifyHandlerSignature(vector.secret, vector.header, vector.body, { now: clock }))
      .toEqual({ ok: false, code: 'invalid_signature' });

    replaceSubtleVerify((async () => true) as typeof crypto.subtle.verify);
    expect(
      await verifyHandlerSignature(
        vector.secret,
        `t=${vector.timestamp},v1=${'0'.repeat(64)}`,
        'a completely different body',
        { now: clock },
      ),
    ).toEqual({ ok: true });
  });

  it('checks tolerance only after cryptographic verification', async () => {
    let verifyCalls = 0;
    replaceSubtleVerify((async (algorithm, key, signature, data) => {
      verifyCalls += 1;
      return realVerify.call(crypto.subtle, algorithm, key, signature, data);
    }) as typeof crypto.subtle.verify);

    // A badly stale but correctly signed request still reaches subtle.verify,
    // which is what proves the timestamp check did not short-circuit it.
    const result = await verifyHandlerSignature(vector.secret, vector.header, vector.body, {
      now: at(vector.timestamp + 86_400),
    });
    expect(result).toEqual({ ok: false, code: 'stale_timestamp' });
    expect(verifyCalls).toBe(1);
  });

  it('never returns stale_timestamp for a signature that did not verify', async () => {
    replaceSubtleVerify((async () => false) as typeof crypto.subtle.verify);
    for (const drift of [0, 86_400, -86_400]) {
      expect(
        await verifyHandlerSignature(vector.secret, vector.header, vector.body, {
          now: at(vector.timestamp + drift),
        }),
      ).toEqual({ ok: false, code: 'invalid_signature' });
    }
  });
});

describe('signing leaks no secret', () => {
  it('returns a result object carrying only ok and a code', async () => {
    const results = [
      await verifyHandlerSignature(vector.secret, null, vector.body, { now: at(vector.timestamp) }),
      await verifyHandlerSignature(`${vector.secret}-wrong`, vector.header, vector.body, {
        now: at(vector.timestamp),
      }),
      await verifyHandlerSignature(vector.secret, vector.header, vector.body, {
        now: at(vector.timestamp + 86_400),
      }),
    ];
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(result.ok ? ['ok'] : ['code', 'ok']);
      expect(JSON.stringify(result)).not.toContain(vector.secret);
    }
  });

  it('keeps the secret out of the signature header', async () => {
    const header = await signHandlerRequest(vector.secret, vector.body, at(vector.timestamp));
    expect(header).not.toContain(vector.secret);
  });
});
