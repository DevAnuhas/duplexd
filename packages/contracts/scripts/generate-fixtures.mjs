import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { signHandlerRequest } from '../dist/src/index.js';

const root = resolve(import.meta.dirname, '..', 'fixtures');
const secret = 'synthetic-test-secret';
const fixedNow = () => 1_700_000_000_000;

const base = {
  contractVersion: '1',
  sessionId: 'session_fixture_1',
  delegationId: 'delegation_fixture_1',
  offsetMs: 1200,
  transcript: [
    { role: 'user', text: 'Book a table for two tomorrow.', offsetMs: 200 },
    { role: 'assistant', text: 'I will check that for you.', offsetMs: 900 },
  ],
  priorDelegations: [],
};

const requests = {
  booking: { expected: { strict: 'valid', loose: 'valid' }, request: base },
  'order-status': {
    expected: { strict: 'valid', loose: 'valid' },
    request: {
      ...base,
      delegationId: 'delegation_order_1',
      transcript: [{ role: 'user', text: 'Where is order 123?', offsetMs: 50 }],
    },
  },
  'empty-transcript': {
    expected: { strict: 'valid', loose: 'valid' },
    request: { ...base, delegationId: 'delegation_empty_1', transcript: [] },
  },
  'unknown-fields': {
    expected: { strict: 'invalid', loose: 'valid' },
    request: {
      ...base,
      extraTopLevel: 'additive',
      transcript: [{ ...base.transcript[0], extraNested: true }],
    },
  },
  'prior-delegations': {
    expected: { strict: 'valid', loose: 'valid' },
    request: {
      ...base,
      delegationId: 'delegation_prior_1',
      priorDelegations: [
        { delegationId: 'delegation_done', outcome: 'done' },
        { delegationId: 'delegation_running', outcome: 'running' },
      ],
    },
  },
  'missing-field': {
    expected: { strict: 'invalid', loose: 'invalid' },
    request: Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'sessionId')),
  },
  'wrong-offset': {
    expected: { strict: 'invalid', loose: 'invalid' },
    request: { ...base, offsetMs: 'soon' },
  },
  'keepalive-delay': {
    expected: { strict: 'valid', loose: 'valid' },
    request: {
      ...base,
      delegationId: 'delegation_delay_1',
      consumerContext: { sample: { delayMs: 3000 } },
    },
  },
};

const eventAt = '2026-01-01T00:00:00.000Z';

/** A CoreEvent line stream, so the parser is exercised over a second schema. */
function coreEventStream() {
  const events = [
    { type: 'session.started', payload: {} },
    {
      type: 'transcript.user.delta',
      payload: { text: 'Book a table for two tomorrow.', offsetMs: 200 },
    },
    { type: 'delegation.created', payload: { delegationId: 'delegation_fixture_1', offsetMs: 1200 } },
    {
      type: 'provider.raw',
      payload: { event: { nested: [1, null, { deep: ['ok', true] }] } },
    },
    { type: 'session.closed', payload: { usage: { seconds: 12.5, raw: { tier: 'test' } } } },
  ];
  return events
    .map((event, index) =>
      JSON.stringify({
        type: event.type,
        sessionId: base.sessionId,
        seq: index + 1,
        at: eventAt,
        payload: event.payload,
      }),
    )
    .join('\n')
    .concat('\n');
}

const results = {
  'booking.ndjson': [
    { kind: 'thinking', content: 'Checking the booking request.' },
    { kind: 'commentary', content: 'The booking request is confirmed.' },
    { kind: 'done' },
  ]
    .map((item) => JSON.stringify(item))
    .join('\n')
    .concat('\n'),
  'keepalives.ndjson': ' \r\n\n{"kind":"commentary","content":"Still checking."}\r\n{"kind":"done"}\r\n',
  'clean-end.ndjson': '{"kind":"commentary","content":"Complete without an explicit marker."}',
  // A legitimate order-status answer: the handler has nothing to say and just
  // finishes. It carries no delay, so it makes no buffering claim either.
  'order-status.ndjson': '{"kind":"done"}\n',
  'unknown-kind.ndjson': '{"kind":"mystery","content":"unknown"}\n',
  'oversized.ndjson': `${JSON.stringify({ kind: 'commentary', content: 'word '.repeat(700) })}\n`,
  'exact-max.ndjson': `${JSON.stringify({ kind: 'commentary', content: 'x'.repeat(500) })}\n{"kind":"done"}\n`,
  'line-too-long.ndjson': `${JSON.stringify({ kind: 'commentary', content: 'x'.repeat(66_000) })}\n`,
  'oversized-whitespace.ndjson': `${' '.repeat(65_537)}\n`,
  'core-event.ndjson': coreEventStream(),
};

/**
 * `expectOutcome` is "done" when the generator runs to completion and "error"
 * when it throws; it is deliberately NOT a claim about the last item's kind.
 * `expectFinalDone` carries that separately, so `clean-end.ndjson` — a stream
 * that ends cleanly without a `done` marker — is representable without lying.
 * `schema` names the line schema the parser is instantiated over.
 */
const resultIndex = {
  'booking.ndjson': {
    schema: 'HandlerResult',
    expectItems: 3,
    expectOutcome: 'done',
    expectFinalDone: true,
  },
  'keepalives.ndjson': {
    schema: 'HandlerResult',
    expectItems: 2,
    expectOutcome: 'done',
    expectFinalDone: true,
    splitAt: [1, 3, 17],
  },
  'clean-end.ndjson': {
    schema: 'HandlerResult',
    expectItems: 1,
    expectOutcome: 'done',
    expectFinalDone: false,
    splitAt: [8, 24],
  },
  'order-status.ndjson': {
    schema: 'HandlerResult',
    expectItems: 1,
    expectOutcome: 'done',
    expectFinalDone: true,
  },
  'unknown-kind.ndjson': {
    schema: 'HandlerResult',
    expectItems: 0,
    expectOutcome: 'error',
    expectError: 'unknown_kind',
  },
  'oversized.ndjson': {
    schema: 'HandlerResult',
    expectItems: 0,
    expectOutcome: 'error',
    expectError: 'content_too_long',
  },
  'exact-max.ndjson': {
    schema: 'HandlerResult',
    expectItems: 2,
    expectOutcome: 'done',
    expectFinalDone: true,
  },
  'line-too-long.ndjson': {
    schema: 'HandlerResult',
    expectItems: 0,
    expectOutcome: 'error',
    expectError: 'line_too_long',
    splitAt: [32_000, 65_536],
  },
  'oversized-whitespace.ndjson': {
    schema: 'HandlerResult',
    expectItems: 0,
    expectOutcome: 'error',
    expectError: 'line_too_long',
    splitAt: [32_000, 65_536],
  },
  'core-event.ndjson': {
    schema: 'CoreEvent',
    expectItems: 5,
    expectOutcome: 'done',
    expectFinalDone: false,
    splitAt: [7, 120, 240],
  },
};

async function json(path, value) {
  await writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

for (const directory of ['requests', 'results', 'metadata', 'conformance', 'schemas']) {
  await mkdir(resolve(root, directory), { recursive: true });
}
for (const [name, fixture] of Object.entries(requests)) {
  await json(`requests/${name}.json`, fixture);
}
for (const [name, body] of Object.entries(results)) {
  await writeFile(resolve(root, 'results', name), body);
}
await json('results/index.json', resultIndex);

const signedBody = JSON.stringify(base);
const signature = await signHandlerRequest(secret, signedBody, fixedNow);
await json('signing.json', {
  vectors: [{ secret, timestamp: 1_700_000_000, body: signedBody, header: signature }],
  tampered: [
    { base: 0, mutate: 'body', expectCode: 'invalid_signature' },
    { base: 0, mutate: 'timestamp', expectCode: 'invalid_signature' },
    { base: 0, mutate: 'signature', expectCode: 'invalid_signature' },
    { base: 0, mutate: 'body_and_stale', expectCode: 'invalid_signature' },
  ],
});

const validHeaders = [
  ['duplexd-signature', signature],
  ['duplexd-contract-version', '1'],
  ['duplexd-session-id', base.sessionId],
];
const metadata = {
  valid: {
    rawHeaders: validHeaders,
    body: base,
    expected: { helper: { ok: true }, handler: { status: 200 } },
  },
  'session-changed': {
    rawHeaders: validHeaders.map(([name, value]) => [
      name,
      name === 'duplexd-session-id' ? 'other-session' : value,
    ]),
    body: base,
    expected: { helper: { status: 400, code: 'metadata_mismatch' } },
  },
  'session-missing': {
    rawHeaders: validHeaders.filter(([name]) => name !== 'duplexd-session-id'),
    body: base,
    expected: { helper: { status: 400, code: 'metadata_mismatch' } },
  },
  'session-duplicated': {
    rawHeaders: [...validHeaders, ['duplexd-session-id', base.sessionId]],
    body: base,
    expected: { helper: { status: 400, code: 'metadata_mismatch' } },
  },
  'version-changed': {
    rawHeaders: validHeaders.map(([name, value]) => [
      name,
      name === 'duplexd-contract-version' ? '0' : value,
    ]),
    body: base,
    expected: { helper: { status: 400, code: 'metadata_mismatch' } },
  },
  'version-missing': {
    rawHeaders: validHeaders.filter(([name]) => name !== 'duplexd-contract-version'),
    body: base,
    expected: { helper: { status: 400, code: 'metadata_mismatch' } },
  },
  'version-duplicated': {
    rawHeaders: [...validHeaders, ['duplexd-contract-version', '1']],
    body: base,
    expected: { helper: { status: 400, code: 'metadata_mismatch' } },
  },
  'body-session-changed': {
    rawHeaders: validHeaders,
    body: { ...base, sessionId: 'tampered-session' },
    expected: {
      helper: { status: 400, code: 'metadata_mismatch' },
      handler: { status: 401, code: 'invalid_signature', helperCalled: false },
    },
  },
  'unsupported-version': {
    rawHeaders: validHeaders.map(([name, value]) => [
      name,
      name === 'duplexd-contract-version' ? '0' : value,
    ]),
    body: { ...base, contractVersion: '0' },
    expected: { helper: { status: 400, code: 'unsupported_contract_version' } },
  },
  'case-insensitive-and-comma-id': {
    rawHeaders: [
      ['DUPLEXD-CONTRACT-VERSION', '1'],
      ['Duplexd-Session-Id', 'opaque,id'],
    ],
    body: { ...base, sessionId: 'opaque,id' },
    expected: { helper: { ok: true } },
  },
};
for (const [name, fixture] of Object.entries(metadata)) {
  await json(`metadata/${name}.json`, fixture);
}

const scenarioDefinitions = {
  'booking-request': ['booking', 'valid_stream'],
  'order-status-request': ['order-status', 'valid_stream'],
  'empty-transcript': ['empty-transcript', 'valid_stream'],
  'unknown-fields': ['unknown-fields', 'valid_stream'],
  'prior-delegations': ['prior-delegations', 'valid_stream'],
  'bad-signature': ['booking', 'problem', 401, 'invalid_signature'],
  'stale-timestamp': ['booking', 'problem', 401, 'stale_timestamp'],
  'unsupported-version': ['booking', 'problem', 400, 'unsupported_contract_version'],
  'metadata-mismatch-session': ['booking', 'problem', 400, 'metadata_mismatch'],
  'metadata-mismatch-version': ['booking', 'problem', 400, 'metadata_mismatch'],
  'metadata-duplicate-header': ['booking', 'problem', 400, 'metadata_mismatch'],
  'replayed-request': ['booking', 'same_commentary'],
  'concurrent-replay': ['booking', 'same_commentary'],
  'keepalive-under-delay': ['keepalive-delay', 'early_keepalive'],
};
for (const [name, [request, expectation, status, code]] of Object.entries(
  scenarioDefinitions,
)) {
  await json(`conformance/${name}.json`, {
    name,
    request,
    expectation,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  });
}

await json('schemas/session-config.json', {
  syntheticSecret: secret,
  valid: {
    provider: 'openai-gpt-live',
    instructions: 'Speak clearly and delegate when help is needed.',
    handler: {
      type: 'remote',
      url: 'https://handler.example.com/delegations',
      auth: { type: 'hmac-sha256', secret },
    },
  },
});

// ---------------------------------------------------------------------------
// Non-request schema cases.
//
// Every file is `{ cases: [{ name, schema, value, expected, crossValidator?,
// reason? }] }`. `schema` names both the Zod export and the committed
// `schema/<Name>.json` file, so one suite can assert the two verdicts agree.
// `crossValidator: false` marks the single documented exception — the
// serialized-UTF-8 `consumerContext` bound, which draft 2020-12 cannot express
// — and `reason` records why, so the exclusion is asserted rather than silent.
// ---------------------------------------------------------------------------

const remoteHandler = {
  type: 'remote',
  url: 'https://handler.example.com/delegations',
  auth: { type: 'hmac-sha256', secret },
};
// Inventoried synthetic secrets for the auth length boundary: exactly the
// sixteen-character minimum, and one character short of it.
const minimumSecret = 'synthetic-16char';
const tooShortSecret = 'synthetic-15cha';

const sessionBase = {
  provider: 'openai-gpt-live',
  instructions: 'Speak clearly and delegate when help is needed.',
};

/** `JSON.stringify({ pad })` is `{"pad":"…"}` — ten bytes of frame plus `pad`. */
const CONTEXT_FRAME_BYTES = 10;
const asciiContext = (bytes) => ({ pad: 'x'.repeat(bytes - CONTEXT_FRAME_BYTES) });
const euroContext = (euros, extraAscii = 0) => ({
  pad: '€'.repeat(euros) + 'x'.repeat(extraAscii),
});

const validUrls = [
  'https://example.com',
  'https://example.com/delegations',
  'https://example.com:8443/delegations?tenant=1',
  'https://sub.domain.example.com/delegations',
  'https://[2001:db8::1]:8443/delegations',
  'http://localhost:8787',
  'http://localhost/delegations?a=b',
  'http://127.0.0.1:8787/delegations',
  'http://[::1]:8787',
  'http://[::1]/delegations',
];
const invalidUrls = [
  'http://example.com',
  'http://LOCALHOST',
  'http://localhost.evil.com',
  'https://user:pw@handler.example.com',
  'https://user@handler.example.com',
  'https://handler.example.com/#fragment',
  'https://handler.example.com/delegations#fragment',
  'https://exa mple.com',
  ' https://example.com',
  '/delegations',
  'example.com',
  'https://:',
  'https://handler.example.com:abc',
  'https://[garbage',
  'ftp://example.com',
  '',
  'https://',
];

const sessionCases = [
  {
    name: 'minimal remote handler session',
    schema: 'SessionConfig',
    value: { ...sessionBase, handler: remoteHandler },
    expected: 'valid',
  },
  {
    name: 'in-process handler session',
    schema: 'SessionConfig',
    value: { ...sessionBase, handler: { type: 'in-process' } },
    expected: 'valid',
  },
  {
    name: 'every optional field populated',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      voice: 'alloy',
      audio: { format: 'pcm16', sampleRateHz: 24000 },
      consumerContext: { tenant: 'acme', nested: [1, null, { deep: true }] },
      handlerTimeoutMs: 45000,
      handler: remoteHandler,
    },
    expected: 'valid',
  },
  {
    name: 'handlerTimeoutMs omitted so the schema default applies',
    schema: 'SessionConfig',
    value: { ...sessionBase, handler: remoteHandler },
    expected: 'valid',
  },
  {
    name: 'handlerTimeoutMs at the lower bound',
    schema: 'SessionConfig',
    value: { ...sessionBase, handlerTimeoutMs: 1000, handler: remoteHandler },
    expected: 'valid',
  },
  {
    name: 'handlerTimeoutMs at the upper bound',
    schema: 'SessionConfig',
    value: { ...sessionBase, handlerTimeoutMs: 120000, handler: remoteHandler },
    expected: 'valid',
  },
  {
    name: 'handlerTimeoutMs below the lower bound',
    schema: 'SessionConfig',
    value: { ...sessionBase, handlerTimeoutMs: 999, handler: remoteHandler },
    expected: 'invalid',
  },
  {
    name: 'handlerTimeoutMs above the upper bound',
    schema: 'SessionConfig',
    value: { ...sessionBase, handlerTimeoutMs: 120001, handler: remoteHandler },
    expected: 'invalid',
  },
  {
    name: 'handlerTimeoutMs is not an integer',
    schema: 'SessionConfig',
    value: { ...sessionBase, handlerTimeoutMs: 30000.5, handler: remoteHandler },
    expected: 'invalid',
  },
  {
    name: 'instructions at the maximum length',
    schema: 'SessionConfig',
    value: { ...sessionBase, instructions: 'i'.repeat(4000), handler: remoteHandler },
    expected: 'valid',
  },
  {
    name: 'instructions one character over the maximum',
    schema: 'SessionConfig',
    value: { ...sessionBase, instructions: 'i'.repeat(4001), handler: remoteHandler },
    expected: 'invalid',
  },
  {
    name: 'instructions empty',
    schema: 'SessionConfig',
    value: { ...sessionBase, instructions: '', handler: remoteHandler },
    expected: 'invalid',
  },
  {
    name: 'unknown provider literal',
    schema: 'SessionConfig',
    value: { ...sessionBase, provider: 'anthropic-live', handler: remoteHandler },
    expected: 'invalid',
  },
  {
    name: 'unknown top-level key',
    schema: 'SessionConfig',
    value: { ...sessionBase, handler: remoteHandler, extraTopLevel: true },
    expected: 'invalid',
  },
  {
    name: 'unknown key nested in audio',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      audio: { format: 'pcm16', extraNested: true },
      handler: remoteHandler,
    },
    expected: 'invalid',
  },
  {
    name: 'unknown key nested in handler auth',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      handler: { ...remoteHandler, auth: { ...remoteHandler.auth, extraNested: true } },
    },
    expected: 'invalid',
  },
  {
    name: 'unsupported audio sample rate',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      audio: { format: 'pcm16', sampleRateHz: 44100 },
      handler: remoteHandler,
    },
    expected: 'invalid',
  },
  {
    name: 'unsupported audio format',
    schema: 'SessionConfig',
    value: { ...sessionBase, audio: { format: 'opus' }, handler: remoteHandler },
    expected: 'invalid',
  },
  {
    name: 'remote handler auth secret at the minimum length',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      handler: { ...remoteHandler, auth: { type: 'hmac-sha256', secret: minimumSecret } },
    },
    expected: 'valid',
  },
  {
    name: 'remote handler auth secret one character short',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      handler: { ...remoteHandler, auth: { type: 'hmac-sha256', secret: tooShortSecret } },
    },
    expected: 'invalid',
  },
  {
    name: 'remote handler auth type is not hmac-sha256',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      handler: { ...remoteHandler, auth: { type: 'bearer', secret } },
    },
    expected: 'invalid',
  },
  {
    name: 'remote handler without auth',
    schema: 'SessionConfig',
    value: {
      ...sessionBase,
      handler: { type: 'remote', url: remoteHandler.url },
    },
    expected: 'invalid',
  },
  {
    name: 'unknown handler discriminator',
    schema: 'SessionConfig',
    value: { ...sessionBase, handler: { type: 'carrier-pigeon' } },
    expected: 'invalid',
  },
  {
    name: 'handler omitted',
    schema: 'SessionConfig',
    value: { ...sessionBase },
    expected: 'invalid',
  },
  {
    name: 'handler omitted',
    schema: 'SessionCreateRequest',
    value: { ...sessionBase },
    expected: 'valid',
  },
  {
    name: 'handler present',
    schema: 'SessionCreateRequest',
    value: { ...sessionBase, handler: remoteHandler },
    expected: 'valid',
  },
  {
    name: 'handler present but malformed',
    schema: 'SessionCreateRequest',
    value: { ...sessionBase, handler: { type: 'remote', url: 'http://example.com' } },
    expected: 'invalid',
  },
  {
    name: 'unknown top-level key',
    schema: 'SessionCreateRequest',
    value: { ...sessionBase, extraTopLevel: true },
    expected: 'invalid',
  },
  {
    name: 'instructions one character over the maximum',
    schema: 'SessionCreateRequest',
    value: { ...sessionBase, instructions: 'i'.repeat(4001) },
    expected: 'invalid',
  },
];

for (const url of validUrls) {
  sessionCases.push({
    name: `handler url accepted: ${url}`,
    schema: 'SessionConfig',
    value: { ...sessionBase, handler: { ...remoteHandler, url } },
    expected: 'valid',
  });
}
for (const url of invalidUrls) {
  sessionCases.push({
    name: `handler url rejected: ${JSON.stringify(url)}`,
    schema: 'SessionConfig',
    value: { ...sessionBase, handler: { ...remoteHandler, url } },
    expected: 'invalid',
  });
}

const contextExceptionReason =
  'draft 2020-12 has no keyword for the serialized-UTF-8 byte length of an arbitrary JSON value, so this bound is enforced by native Zod only';
for (const schema of ['SessionConfig', 'SessionCreateRequest']) {
  const withHandler = schema === 'SessionConfig' ? { handler: remoteHandler } : {};
  sessionCases.push(
    {
      name: 'consumerContext serializing to exactly 16384 ASCII bytes',
      schema,
      value: { ...sessionBase, ...withHandler, consumerContext: asciiContext(16384) },
      expected: 'valid',
      crossValidator: false,
      reason: contextExceptionReason,
    },
    {
      name: 'consumerContext serializing to 16385 ASCII bytes',
      schema,
      value: { ...sessionBase, ...withHandler, consumerContext: asciiContext(16385) },
      expected: 'invalid',
      crossValidator: false,
      reason: contextExceptionReason,
    },
    {
      name: 'consumerContext serializing to exactly 16384 bytes of multibyte text',
      schema,
      value: { ...sessionBase, ...withHandler, consumerContext: euroContext(5458) },
      expected: 'valid',
      crossValidator: false,
      reason: contextExceptionReason,
    },
    {
      name: 'consumerContext serializing to 16385 bytes of multibyte text',
      schema,
      value: { ...sessionBase, ...withHandler, consumerContext: euroContext(5458, 1) },
      expected: 'invalid',
      crossValidator: false,
      reason: contextExceptionReason,
    },
  );
}

await json('schemas/session.json', { cases: sessionCases });

const coreEvent = (type, payload, overrides = {}) => ({
  type,
  sessionId: base.sessionId,
  seq: 1,
  at: eventAt,
  payload,
  ...overrides,
});

await json('schemas/core-event.json', {
  cases: [
    { name: 'session.started', value: coreEvent('session.started', {}), expected: 'valid' },
    { name: 'session.closing', value: coreEvent('session.closing', {}), expected: 'valid' },
    {
      name: 'session.closed',
      value: coreEvent('session.closed', { usage: { seconds: 12.5, raw: { tier: 'test' } } }),
      expected: 'valid',
    },
    {
      name: 'session.failed',
      value: coreEvent('session.failed', { reason: 'provider refused the session' }),
      expected: 'valid',
    },
    ...[
      'provider_disconnected',
      'provider_final_event_missing',
      'process_shutdown',
      'instance_lost',
    ].map((reason) => ({
      name: `session.incomplete ${reason}`,
      value: coreEvent('session.incomplete', { reason }),
      expected: 'valid',
    })),
    {
      name: 'transcript.user.delta',
      value: coreEvent('transcript.user.delta', { text: 'Book a table.', offsetMs: 200 }),
      expected: 'valid',
    },
    {
      name: 'transcript.assistant.delta',
      value: coreEvent('transcript.assistant.delta', { text: 'On it.', offsetMs: 900 }),
      expected: 'valid',
    },
    {
      name: 'delegation.created',
      value: coreEvent('delegation.created', {
        delegationId: 'delegation_fixture_1',
        offsetMs: 1200,
      }),
      expected: 'valid',
    },
    {
      name: 'delegation.finished without an error',
      value: coreEvent('delegation.finished', {
        delegationId: 'delegation_fixture_1',
        outcome: 'done',
      }),
      expected: 'valid',
    },
    {
      name: 'delegation.finished with the optional error',
      value: coreEvent('delegation.finished', {
        delegationId: 'delegation_fixture_1',
        outcome: 'error',
        error: 'handler returned 500',
      }),
      expected: 'valid',
    },
    {
      name: 'delegation.finished cannot report running',
      value: coreEvent('delegation.finished', {
        delegationId: 'delegation_fixture_1',
        outcome: 'running',
      }),
      expected: 'invalid',
    },
    {
      name: 'append.sent with a delegation id',
      value: coreEvent('append.sent', {
        delegationId: 'delegation_fixture_1',
        kind: 'commentary',
        tokens: 12,
      }),
      expected: 'valid',
    },
    {
      name: 'append.sent with a null delegation id',
      value: coreEvent('append.sent', { delegationId: null, kind: 'instruction', tokens: 0 }),
      expected: 'valid',
    },
    ...['over_budget', 'unknown_delegation', 'delegation_finished', 'provider_error'].map(
      (reason) => ({
        name: `append.rejected ${reason}`,
        value: coreEvent('append.rejected', {
          delegationId: null,
          kind: 'thinking',
          reason,
        }),
        expected: 'valid',
      }),
    ),
    {
      name: 'append.rejected with every optional field',
      value: coreEvent('append.rejected', {
        delegationId: 'delegation_fixture_1',
        kind: 'commentary',
        reason: 'over_budget',
        tokens: 501,
        chars: 640,
        detail: 'append exceeded the token budget',
      }),
      expected: 'valid',
    },
    {
      name: 'append.rejected with an unknown reason',
      value: coreEvent('append.rejected', {
        delegationId: null,
        kind: 'commentary',
        reason: 'vibes',
      }),
      expected: 'invalid',
    },
    {
      name: 'transport.dtmf',
      value: coreEvent('transport.dtmf', { digit: '5' }),
      expected: 'valid',
    },
    {
      name: 'provider.raw carrying recursive JSON',
      value: coreEvent('provider.raw', {
        event: { a: [1, null, true, 'x', { b: { c: [[], {}] } }] },
      }),
      expected: 'valid',
    },
    {
      name: 'provider.raw carrying a bare JSON scalar',
      value: coreEvent('provider.raw', { event: null }),
      expected: 'valid',
    },
    {
      name: 'unknown event type',
      value: coreEvent('session.teleported', {}),
      expected: 'invalid',
    },
    {
      name: 'seq below one',
      value: coreEvent('session.started', {}, { seq: 0 }),
      expected: 'invalid',
    },
    {
      name: 'seq is not an integer',
      value: coreEvent('session.started', {}, { seq: 1.5 }),
      expected: 'invalid',
    },
    {
      name: 'empty sessionId',
      value: coreEvent('session.started', {}, { sessionId: '' }),
      expected: 'invalid',
    },
    {
      name: 'at is not an ISO-8601 timestamp',
      value: coreEvent('session.started', {}, { at: 'yesterday' }),
      expected: 'invalid',
    },
    {
      name: 'unknown key at the event level',
      value: coreEvent('session.started', {}, { extraTopLevel: true }),
      expected: 'invalid',
    },
    {
      name: 'unknown key nested in the payload',
      value: coreEvent('transport.dtmf', { digit: '5', extraNested: true }),
      expected: 'invalid',
    },
    {
      name: 'unknown key nested two levels down, inside usage',
      value: coreEvent('session.closed', {
        usage: { seconds: 1, raw: {}, extraNested: true },
      }),
      expected: 'invalid',
    },
  ].map((entry) => ({ ...entry, schema: 'CoreEvent' })),
});

await json('schemas/handler-result.json', {
  cases: [
    { name: 'thinking', value: { kind: 'thinking', content: 'Checking.' }, expected: 'valid' },
    { name: 'commentary', value: { kind: 'commentary', content: 'Confirmed.' }, expected: 'valid' },
    {
      name: 'instruction',
      value: { kind: 'instruction', content: 'Ask for the date.' },
      expected: 'valid',
    },
    { name: 'done', value: { kind: 'done' }, expected: 'valid' },
    { name: 'error', value: { kind: 'error', message: 'upstream failed' }, expected: 'valid' },
    {
      name: 'content at exactly MAX_CONTENT_CHARS',
      value: { kind: 'commentary', content: 'c'.repeat(500) },
      expected: 'valid',
    },
    {
      name: 'content one character over MAX_CONTENT_CHARS',
      value: { kind: 'commentary', content: 'c'.repeat(501) },
      expected: 'invalid',
    },
    {
      name: 'known kind tolerates an extra field',
      value: { kind: 'commentary', content: 'Confirmed.', traceId: 'abc' },
      expected: 'valid',
    },
    {
      name: 'done tolerates an extra field',
      value: { kind: 'done', traceId: 'abc' },
      expected: 'valid',
    },
    { name: 'unknown kind', value: { kind: 'mystery', content: 'x' }, expected: 'invalid' },
    { name: 'content variant without content', value: { kind: 'commentary' }, expected: 'invalid' },
    { name: 'error without a message', value: { kind: 'error' }, expected: 'invalid' },
    {
      name: 'content is not a string',
      value: { kind: 'commentary', content: 12 },
      expected: 'invalid',
    },
    { name: 'kind missing', value: { content: 'x' }, expected: 'invalid' },
  ].map((entry) => ({ ...entry, schema: 'HandlerResult' })),
});

const recordBase = {
  contractVersion: '1',
  sessionId: base.sessionId,
  provider: 'openai-gpt-live',
  state: 'closed',
  createdAt: eventAt,
  startedAt: eventAt,
  endedAt: '2026-01-01T00:05:00.000Z',
  usage: { seconds: 300, raw: { tier: 'test' } },
  instructions: 'Speak clearly and delegate when help is needed.',
  voice: 'alloy',
  handler: { type: 'remote', url: 'https://handler.example.com/delegations' },
  transcript: [{ role: 'user', text: 'Book a table.', offsetMs: 200 }],
  delegations: [
    {
      delegationId: 'delegation_fixture_1',
      offsetMs: 1200,
      outcome: 'done',
      createdAt: eventAt,
      finishedAt: '2026-01-01T00:00:03.000Z',
      appends: 2,
    },
  ],
  appends: [
    { seq: 1, delegationId: 'delegation_fixture_1', kind: 'commentary', tokens: 12, at: eventAt },
    { seq: 2, delegationId: null, kind: 'instruction', tokens: 4, at: eventAt },
  ],
  rejectedAppends: [
    {
      seq: 3,
      delegationId: 'delegation_fixture_1',
      kind: 'commentary',
      reason: 'over_budget',
      at: eventAt,
    },
  ],
};

const withoutRecordKeys = (keys) =>
  Object.fromEntries(Object.entries(recordBase).filter(([key]) => !keys.includes(key)));

await json('schemas/call-record.json', {
  cases: [
    { name: 'closed record', value: recordBase, expected: 'valid' },
    {
      name: 'failed record with a reason carries no usage',
      value: { ...withoutRecordKeys(['usage']), state: 'failed', reason: 'provider disconnected' },
      expected: 'valid',
    },
    {
      name: 'incomplete record with a reason carries no usage',
      value: {
        ...withoutRecordKeys(['usage']),
        state: 'incomplete',
        reason: 'instance_lost',
        transcript: [],
      },
      expected: 'valid',
    },
    {
      name: 'a closed record may omit usage',
      value: withoutRecordKeys(['usage']),
      expected: 'valid',
    },
    {
      name: 'a failed record carrying usage is rejected',
      value: { ...recordBase, state: 'failed' },
      expected: 'invalid',
    },
    {
      name: 'an incomplete record carrying usage is rejected',
      value: { ...recordBase, state: 'incomplete' },
      expected: 'invalid',
    },
    {
      name: 'in-process handler is stored without auth',
      value: { ...recordBase, handler: { type: 'in-process' } },
      expected: 'valid',
    },
    {
      name: 'optional startedAt, voice and reason all omitted',
      value: withoutRecordKeys(['startedAt', 'voice']),
      expected: 'valid',
    },
    {
      name: 'a running delegation is representable',
      value: {
        ...recordBase,
        delegations: [
          {
            delegationId: 'delegation_running',
            offsetMs: 1200,
            outcome: 'running',
            createdAt: eventAt,
            appends: 0,
          },
        ],
      },
      expected: 'valid',
    },
    {
      name: 'the stored handler cannot carry auth material',
      value: {
        ...recordBase,
        handler: { type: 'remote', url: recordBase.handler.url, auth: { type: 'hmac-sha256', secret } },
      },
      expected: 'invalid',
    },
    {
      name: 'the record cannot carry consumerContext',
      value: { ...recordBase, consumerContext: { tenant: 'acme' } },
      expected: 'invalid',
    },
    {
      name: 'unknown state',
      value: { ...recordBase, state: 'abandoned' },
      expected: 'invalid',
    },
    {
      name: 'wrong contract version literal',
      value: { ...recordBase, contractVersion: '0' },
      expected: 'invalid',
    },
    {
      name: 'endedAt missing',
      value: withoutRecordKeys(['endedAt']),
      expected: 'invalid',
    },
    {
      name: 'unknown key nested in a transcript fragment',
      value: {
        ...recordBase,
        transcript: [{ role: 'user', text: 'Book a table.', offsetMs: 200, extraNested: true }],
      },
      expected: 'invalid',
    },
    {
      name: 'unknown key nested in an append',
      value: {
        ...recordBase,
        appends: [{ ...recordBase.appends[0], extraNested: true }],
      },
      expected: 'invalid',
    },
    {
      name: 'append seq below one',
      value: { ...recordBase, appends: [{ ...recordBase.appends[0], seq: 0 }] },
      expected: 'invalid',
    },
    {
      name: 'rejected append with an unknown reason',
      value: {
        ...recordBase,
        rejectedAppends: [{ ...recordBase.rejectedAppends[0], reason: 'vibes' }],
      },
      expected: 'invalid',
    },
  ].map((entry) => ({ ...entry, schema: 'CallRecord' })),
});
