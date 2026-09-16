import { request as httpRequest } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTRACT_VERSION, HandlerResult, parseNdjson, signHandlerRequest } from '@duplexd/contracts';
import { type RunningHandler, startReferenceHandler } from '@duplexd/contracts/conformance';

import { readFixtureJson, SYNTHETIC_TEST_SECRET } from './support/fixtures.js';
import { collect } from './support/streams.js';

const secret = SYNTHETIC_TEST_SECRET;
const booking = readFixtureJson<{ request: Record<string, unknown> }>(
  'requests',
  'booking.json',
).request;

let handler: RunningHandler;

beforeAll(async () => {
  handler = await startReferenceHandler(secret);
});
afterAll(async () => {
  await handler.close();
});

interface SendOptions {
  body?: string;
  signWith?: string;
  now?: () => number;
  headers?: Record<string, string>;
  omitHeaders?: string[];
  url?: string;
  method?: string;
}

async function send(options: SendOptions = {}): Promise<Response> {
  const raw = options.body ?? JSON.stringify(booking);
  const parsed = ((): { contractVersion?: unknown; sessionId?: unknown } => {
    try {
      const value: unknown = JSON.parse(raw);
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  })();

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'duplexd-signature': await signHandlerRequest(options.signWith ?? secret, raw, options.now),
    'duplexd-contract-version': String(parsed.contractVersion ?? CONTRACT_VERSION),
    'duplexd-session-id': String(parsed.sessionId ?? booking.sessionId),
    ...options.headers,
  };
  for (const name of options.omitHeaders ?? []) delete headers[name];

  return fetch(options.url ?? handler.url, {
    method: options.method ?? 'POST',
    headers,
    body: raw,
    redirect: 'error',
  });
}

async function problemOf(response: Response): Promise<{ code?: string; detail?: string }> {
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  return (await response.json()) as { code?: string; detail?: string };
}

async function expectProblem(
  response: Response,
  status: number,
  code: string,
): Promise<{ code?: string; detail?: string }> {
  const problem = await problemOf(response);
  expect({ status: response.status, code: problem.code }).toEqual({ status, code });
  return problem;
}

/** Two actual header fields on the wire, not a Fetch comma-joined surrogate. */
function sendWithDuplicateHeader(
  name: string,
  values: [string, string],
  signature: string,
  raw: string,
): Promise<{ status: number; contentType: string; body: string }> {
  const target = new URL(handler.url);
  const baseHeaders: Record<string, string | string[]> = {
    'content-type': 'application/json',
    'content-length': String(new TextEncoder().encode(raw).byteLength),
    'duplexd-signature': signature,
    'duplexd-contract-version': CONTRACT_VERSION,
    'duplexd-session-id': String(booking.sessionId),
  };
  baseHeaders[name] = values;

  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(target, { method: 'POST', headers: baseHeaders }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () =>
        resolvePromise({
          status: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          body,
        }),
      );
    });
    request.once('error', reject);
    request.end(raw);
  });
}

describe('the reference handler accepts a valid request', () => {
  it('answers 200 with an NDJSON stream whose last item is done', async () => {
    const response = await send();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(response.body).not.toBeNull();
    if (response.body === null) return;

    const items = await collect(parseNdjson(response.body, (json) => HandlerResult.parse(json)));
    expect(items.length).toBeGreaterThan(0);
    expect(items.at(-1)).toEqual({ kind: 'done' });
  });

  it('serves a done-only answer for a transcript it cannot help with', async () => {
    const orderStatus = readFixtureJson<{ request: Record<string, unknown> }>(
      'requests',
      'order-status.json',
    ).request;
    const response = await send({ body: JSON.stringify(orderStatus) });
    expect(response.status).toBe(200);
    if (response.body === null) return;
    const items = await collect(parseNdjson(response.body, (json) => HandlerResult.parse(json)));
    expect(items.at(-1)).toEqual({ kind: 'done' });
  });

  it('answers 404 for anything but POST /delegations', async () => {
    const root = new URL(handler.url);
    root.pathname = '/';
    await expectProblem(await send({ url: root.toString() }), 404, 'not_found');
    await expectProblem(await send({ method: 'PUT' }), 404, 'not_found');
  });
});

describe('the reference handler stops at the first failing step', () => {
  it('step 1: a bad signature is 401 invalid_signature', async () => {
    await expectProblem(await send({ signWith: `${secret}-wrong` }), 401, 'invalid_signature');
  });

  it('step 1: a missing signature header is 401 invalid_signature', async () => {
    await expectProblem(
      await send({ omitHeaders: ['duplexd-signature'] }),
      401,
      'invalid_signature',
    );
  });

  it('step 1: a duplicated signature header is 401 invalid_signature', async () => {
    // Two signature fields leave the handler with no single value to trust.
    const raw = JSON.stringify(booking);
    const signature = await signHandlerRequest(secret, raw);
    const response = await sendWithDuplicateHeader(
      'duplexd-signature',
      [signature, signature],
      signature,
      raw,
    );
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).code).toBe('invalid_signature');
  });

  it('step 1: a stale timestamp is 401 stale_timestamp', async () => {
    await expectProblem(
      await send({ now: () => Date.now() - 10 * 60 * 1000 }),
      401,
      'stale_timestamp',
    );
  });

  it('step 2: signed malformed JSON is 400 malformed_body, not a 500', async () => {
    await expectProblem(await send({ body: '{"contractVersion":' }), 400, 'malformed_body');
    await expectProblem(await send({ body: 'not json at all' }), 400, 'malformed_body');
    await expectProblem(await send({ body: '' }), 400, 'malformed_body');
  });

  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"a scalar"'],
    ['a boolean', 'true'],
    ['an array', '[{"contractVersion":"1"}]'],
  ])('step 3: a signed %s body is refused without throwing', async (_label, raw) => {
    // These parse as JSON but carry no fields for the headers to equal, so the
    // earliest applicable failure is the metadata check — never a 500.
    const response = await send({ body: raw });
    expect(response.status).toBe(400);
    const problem = await problemOf(response);
    expect(problem.code).toBe('metadata_mismatch');
  });

  it('step 3: a changed session header is 400 metadata_mismatch', async () => {
    const problem = await expectProblem(
      await send({ headers: { 'duplexd-session-id': 'another-session' } }),
      400,
      'metadata_mismatch',
    );
    expect(problem.detail).toContain('duplexd-session-id');
  });

  it('step 3: a header-only version mismatch is metadata_mismatch, not unsupported', async () => {
    const problem = await expectProblem(
      await send({ headers: { 'duplexd-contract-version': '0' } }),
      400,
      'metadata_mismatch',
    );
    expect(problem.detail).toContain('duplexd-contract-version');
  });

  it('step 3: a missing metadata header is 400 metadata_mismatch', async () => {
    for (const name of ['duplexd-contract-version', 'duplexd-session-id']) {
      await expectProblem(await send({ omitHeaders: [name] }), 400, 'metadata_mismatch');
    }
  });

  it('step 3: a duplicated metadata header sent as two real fields is refused', async () => {
    const raw = JSON.stringify(booking);
    const signature = await signHandlerRequest(secret, raw);
    const response = await sendWithDuplicateHeader(
      'duplexd-session-id',
      [String(booking.sessionId), String(booking.sessionId)],
      signature,
      raw,
    );
    expect(response.status).toBe(400);
    expect(response.contentType).toBe('application/problem+json');
    expect(JSON.parse(response.body).code).toBe('metadata_mismatch');
  });

  it('step 4: a body version of "0" is 400 unsupported_contract_version', async () => {
    const raw = JSON.stringify({ ...booking, contractVersion: '0' });
    await expectProblem(await send({ body: raw }), 400, 'unsupported_contract_version');
  });

  it('step 5: a metadata-clean but schema-invalid body is 400 invalid_request', async () => {
    const raw = JSON.stringify({ ...booking, offsetMs: 'soon' });
    await expectProblem(await send({ body: raw }), 400, 'invalid_request');
  });

  it('step 5: an extra field is tolerated because the handler validates loosely', async () => {
    const raw = JSON.stringify({ ...booking, extraTopLevel: 'additive' });
    expect((await send({ body: raw })).status).toBe(200);
  });
});

describe('the earliest applicable problem wins', () => {
  it('signature beats metadata, version and schema together', async () => {
    const raw = JSON.stringify({ ...booking, contractVersion: '0', offsetMs: 'soon' });
    await expectProblem(
      await send({
        body: raw,
        signWith: `${secret}-wrong`,
        headers: { 'duplexd-session-id': 'another-session' },
      }),
      401,
      'invalid_signature',
    );
  });

  it('staleness beats metadata, version and schema together', async () => {
    const raw = JSON.stringify({ ...booking, contractVersion: '0', offsetMs: 'soon' });
    await expectProblem(
      await send({
        body: raw,
        now: () => Date.now() - 10 * 60 * 1000,
        headers: { 'duplexd-session-id': 'another-session' },
      }),
      401,
      'stale_timestamp',
    );
  });

  it('malformed body beats metadata and schema', async () => {
    await expectProblem(
      await send({
        body: '{ not json',
        headers: { 'duplexd-session-id': 'another-session', 'duplexd-contract-version': '0' },
      }),
      400,
      'malformed_body',
    );
  });

  it('metadata beats version', async () => {
    const raw = JSON.stringify({ ...booking, contractVersion: '0' });
    await expectProblem(
      await send({ body: raw, headers: { 'duplexd-contract-version': CONTRACT_VERSION } }),
      400,
      'metadata_mismatch',
    );
  });

  it('version beats schema', async () => {
    const raw = JSON.stringify({ ...booking, contractVersion: '0', offsetMs: 'soon' });
    await expectProblem(await send({ body: raw }), 400, 'unsupported_contract_version');
  });

  it('a body tampered after signing fails at the signature, never at metadata', async () => {
    // The metadata fixture records both scopes: the isolated helper sees a
    // real mismatch, but the pipeline never reaches it. A 401 here is the
    // proof — the helper structurally cannot produce that code, and its
    // metadata_mismatch (which metadata.test.ts shows it does return for these
    // exact inputs) never appears.
    const fixture = readFixtureJson<{
      rawHeaders: Array<[string, string]>;
      body: Record<string, unknown>;
      expected: { handler: { status: number; code: string; helperCalled: boolean } };
    }>('metadata', 'body-session-changed.json');

    const signedBody = JSON.stringify(booking);
    const tamperedBody = JSON.stringify({ ...booking, sessionId: 'tampered-session' });
    const signature = await signHandlerRequest(secret, signedBody);

    const response = await fetch(handler.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'duplexd-signature': signature,
        'duplexd-contract-version': CONTRACT_VERSION,
        'duplexd-session-id': String(booking.sessionId),
      },
      body: tamperedBody,
      redirect: 'error',
    });

    const problem = await expectProblem(
      response,
      fixture.expected.handler.status,
      fixture.expected.handler.code,
    );
    expect(fixture.expected.handler.helperCalled).toBe(false);
    // The helper always supplies a detail naming a header; a signature
    // rejection carries none.
    expect(problem.detail).toBeUndefined();
  });
});

describe('the reference handler never leaks or trusts the wrong thing', () => {
  it('returns application/problem+json on every rejection', async () => {
    const rejections = await Promise.all([
      send({ signWith: `${secret}-wrong` }),
      send({ now: () => Date.now() - 10 * 60 * 1000 }),
      send({ body: '{ not json' }),
      send({ headers: { 'duplexd-session-id': 'another-session' } }),
      send({ body: JSON.stringify({ ...booking, contractVersion: '0' }) }),
      send({ body: JSON.stringify({ ...booking, offsetMs: 'soon' }) }),
    ]);
    for (const response of rejections) {
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect([400, 401]).toContain(response.status);
    }
  });

  it('echoes neither the secret, the signature, nor the raw body', async () => {
    const marker = 'CANARY_IN_THE_UNTRUSTED_BODY';
    const raw = JSON.stringify({ ...booking, offsetMs: 'soon', canary: marker });
    const signature = await signHandlerRequest(secret, raw);

    for (const response of [
      await send({ body: raw }),
      await send({ body: raw, signWith: `${secret}-wrong` }),
      await send({ body: `${raw} {` }),
    ]) {
      const text = await response.text();
      expect(text).not.toContain(secret);
      expect(text).not.toContain(signature);
      expect(text).not.toContain(marker);
    }
  });

  it('decides from the signed body, not from the metadata headers', async () => {
    // Same headers, different bodies: the answer follows the body.
    const orderStatus = readFixtureJson<{ request: Record<string, unknown> }>(
      'requests',
      'order-status.json',
    ).request;
    const withBookingSession = { ...orderStatus, sessionId: booking.sessionId };

    const bookingResponse = await send();
    const orderResponse = await send({ body: JSON.stringify(withBookingSession) });
    expect(bookingResponse.status).toBe(200);
    expect(orderResponse.status).toBe(200);
    if (bookingResponse.body === null || orderResponse.body === null) return;

    const bookingItems = await collect(
      parseNdjson(bookingResponse.body, (json) => HandlerResult.parse(json)),
    );
    const orderItems = await collect(
      parseNdjson(orderResponse.body, (json) => HandlerResult.parse(json)),
    );
    expect(bookingItems).not.toEqual(orderItems);
  });

  it('answers identically for a replayed request, sequentially and concurrently', async () => {
    const raw = JSON.stringify(booking);
    const signature = await signHandlerRequest(secret, raw);
    const replay = () =>
      fetch(handler.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'duplexd-signature': signature,
          'duplexd-contract-version': CONTRACT_VERSION,
          'duplexd-session-id': String(booking.sessionId),
        },
        body: raw,
        redirect: 'error',
      }).then((response) => response.text());

    const first = await replay();
    const second = await replay();
    expect(second).toBe(first);

    const [third, fourth] = await Promise.all([replay(), replay()]);
    expect(fourth).toBe(third);
    expect(third).toBe(first);
  });
});

describe('the reference handler binds cleanly', () => {
  it('reports its actual URL on an ephemeral port and closes', async () => {
    const extra = await startReferenceHandler(secret);
    try {
      const url = new URL(extra.url);
      expect(url.protocol).toBe('http:');
      expect(url.hostname).toBe('127.0.0.1');
      expect(Number(url.port)).toBeGreaterThan(0);
      expect(url.port).not.toBe('0');
      expect(url.pathname).toBe('/delegations');
      expect(extra.url).not.toBe(handler.url);
    } finally {
      await extra.close();
    }
    // A closed handler refuses new connections rather than leaking the socket.
    await expect(fetch(extra.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});
