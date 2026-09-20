import { describe, expect, it } from 'vitest';

import {
  projectWorkspaceCallEvent,
  type WorkspaceCallEvent,
  type WorkspaceCallEventRow,
} from '@/data/calls';

/**
 * The workspace-scoped projection over `call_events`.
 *
 * `call_events.payload` is `jsonb` and the write path does not constrain its
 * keys — the agent posts whatever `duplexd_agent/reporting.py` recorded, and a
 * future agent build can add keys without this app knowing. So the read path
 * is a **pick-known-keys whitelist**, never a spread: the projection names
 * every field it is willing to show and copies those, so a key nobody here has
 * heard of cannot reach a tenant's browser by default.
 *
 * That distinction is the thing worth testing, because the two implementations
 * are indistinguishable on the happy path. `{ ...payload }` and a hand-picked
 * `{ text: payload.text }` both render a transcript bubble correctly. They
 * differ only on input nobody wrote a fixture for, which is exactly the input
 * that eventually arrives. Every assertion below about a dropped key is
 * therefore load-bearing: a test that only checked the known keys survived
 * would pass against a spread.
 *
 * The second rule is that a malformed payload degrades **that event** to its
 * envelope and never throws and never drops it. A call detail page that blanks
 * because one event out of four hundred had a null `text` is a worse product
 * than one that shows 399 bubbles and one bare event row.
 *
 * Nothing here touches the database. The projection is a pure function over
 * rows, and the point of testing it that way is that the hostile inputs below
 * — a getter that throws, a payload that is a bare string — cannot be written
 * through the real ingestion path but can absolutely arrive in a column that
 * has been accepting agent JSON since P05.
 */

/** `at` arrives as the `Date` drizzle returns for a `timestamptz`. */
const AT = new Date('2026-09-20T10:00:00.123Z');
const AT_ISO = '2026-09-20T10:00:00.123Z';

/** One stored row, so every case below differs in exactly one way. */
function row(type: string, payload: unknown, seq = 1): WorkspaceCallEventRow {
  return { seq, at: AT, type, payload };
}

/** Named for symmetry with the list-level block at the bottom. */
function project(event: WorkspaceCallEventRow): WorkspaceCallEvent {
  return projectWorkspaceCallEvent(event);
}

/** The envelope every event keeps, whatever happens to its payload. */
function envelope(type: string, seq = 1) {
  return { seq, at: AT_ISO, type };
}

/**
 * The webhook error codes `duplexd_agent/webhooks.py` can emit, mirrored here
 * with the label each becomes.
 *
 * Six of them: the five `WebhookOutcome(error_code=...)` sites in `deliver`
 * and `SharedToolHandler`, plus the `"webhook_failed"` fallback that
 * `WebhookOutcome.callback_value` substitutes when `error_code` is unset.
 *
 * Written out again rather than imported, because the map in `calls.ts` is
 * module-private and importing it would make these assertions compare the
 * implementation with itself. The codes are an internal vocabulary of an
 * internal service: a tenant who sees `webhook_invalid_response` in their call
 * detail is reading our implementation and cannot act on it, and the raw code
 * is never a fallback for a code the map has not heard of — an agent build
 * that adds a seventh code must show "Failed", not leak the new string.
 */
const ERROR_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  webhook_failed: 'Failed',
  webhook_destination_refused: 'Destination refused',
  webhook_unreachable: 'Unreachable',
  webhook_internal_error: 'Internal error',
  webhook_http_error: 'HTTP error',
  webhook_invalid_response: 'Invalid response',
};

/** A `tool_finished` payload that is valid in every respect. */
function toolFinished(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'lookup_order',
    invocationId: 'inv-0001',
    outcome: 'success',
    durationMs: 412,
    ...overrides,
  };
}

describe('the envelope', () => {
  it('is kept for every event, whatever its type', () => {
    expect(project(row('interruption', null, 17))).toStrictEqual(envelope('interruption', 17));
  });

  it('renders `at` as an RFC 3339 string rather than the stored Date', () => {
    const projected = project(row('bot_speech_started', {}, 4));

    expect(projected.seq).toBe(4);
    expect(projected.type).toBe('bot_speech_started');
    expect(projected.at).toBe(AT_ISO);
    expect(projected.at).not.toBeInstanceOf(Date);
  });
});

describe('transcript events', () => {
  it.each(['transcript_user', 'transcript_assistant'])('%s keeps its text', (type) => {
    expect(project(row(type, { text: 'I need to change my address.' }))).toStrictEqual({
      ...envelope(type),
      payload: { text: 'I need to change my address.' },
    });
  });

  it('keeps an empty string, which is a value rather than a missing field', () => {
    expect(project(row('transcript_user', { text: '' }))).toStrictEqual({
      ...envelope('transcript_user'),
      payload: { text: '' },
    });
  });

  /**
   * The projection is not an escaper and must not become one.
   *
   * A caller can say anything, including something that looks like markup, and
   * the transcript has to show what they said. React escapes this at render; a
   * projection that stripped or entity-encoded it here would corrupt honest
   * transcripts to no security benefit, and would hide the corruption behind a
   * bubble that still looked plausible.
   */
  it('passes an HTML-looking utterance through byte for byte', () => {
    const utterance = '<img src=x onerror="alert(1)"> & then I said <b>no</b>';

    expect(project(row('transcript_assistant', { text: utterance }))).toStrictEqual({
      ...envelope('transcript_assistant'),
      payload: { text: utterance },
    });
  });

  it('drops every key beside `text`', () => {
    expect(
      project(
        row('transcript_user', {
          text: 'kept',
          confidence: 0.98,
          speakerId: 'caller-1',
          raw: { provider: 'deepgram', words: [{ word: 'kept' }] },
        }),
      ),
    ).toStrictEqual({ ...envelope('transcript_user'), payload: { text: 'kept' } });
  });

  it.each([
    ['a number', { text: 42 }],
    ['null', { text: null }],
    ['an object', { text: { value: 'nested' } }],
    ['an array of strings', { text: ['a', 'b'] }],
    ['a boolean', { text: true }],
    ['missing entirely', { speakerId: 'caller-1' }],
  ])('degrades to the envelope when text is %s', (_label, payload) => {
    expect(project(row('transcript_user', payload))).toStrictEqual(envelope('transcript_user'));
  });
});

describe('tool_started', () => {
  it('keeps the tool and invocation id', () => {
    expect(
      project(row('tool_started', { tool: 'lookup_order', invocationId: 'inv-0001' })),
    ).toStrictEqual({
      ...envelope('tool_started'),
      payload: { tool: 'lookup_order', invocationId: 'inv-0001' },
    });
  });

  /**
   * `arguments` is the key this rule exists for. The agent sends the caller's
   * arguments to the customer's webhook, and a future build that also recorded
   * them would put order numbers, addresses and card fragments into an event
   * row. A whitelist means that change is invisible here rather than a leak.
   */
  it('drops arguments and every other unlisted key', () => {
    expect(
      project(
        row('tool_started', {
          tool: 'lookup_order',
          invocationId: 'inv-0001',
          arguments: { reference: 'ORD-99', cardLast4: '4242' },
          serverUrl: 'https://tenant.example/hooks',
          timestamp: 1_790_000_000,
        }),
      ),
    ).toStrictEqual({
      ...envelope('tool_started'),
      payload: { tool: 'lookup_order', invocationId: 'inv-0001' },
    });
  });

  it.each([
    ['tool is missing', { invocationId: 'inv-0001' }],
    ['tool is not a string', { tool: 7, invocationId: 'inv-0001' }],
    ['invocationId is missing', { tool: 'lookup_order' }],
    ['invocationId is not a string', { tool: 'lookup_order', invocationId: 12 }],
    ['invocationId is null', { tool: 'lookup_order', invocationId: null }],
  ])('degrades to the envelope when %s', (_label, payload) => {
    expect(project(row('tool_started', payload))).toStrictEqual(envelope('tool_started'));
  });
});

describe('tool_finished', () => {
  it('keeps the required four when the optional two are absent', () => {
    expect(project(row('tool_finished', toolFinished()))).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'success',
        durationMs: 412,
      },
    });
  });

  it.each(['success', 'failure'])('accepts the %s outcome', (outcome) => {
    expect(project(row('tool_finished', toolFinished({ outcome })))).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome,
        durationMs: 412,
      },
    });
  });

  it.each([
    ['zero', 0],
    ['a large duration', 120_000],
    ['a fractional duration', 0.5],
  ])('accepts %s as durationMs', (_label, durationMs) => {
    expect(project(row('tool_finished', toolFinished({ durationMs })))).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'success',
        durationMs,
      },
    });
  });

  it('drops the webhook response body and every other unlisted key', () => {
    expect(
      project(
        row(
          'tool_finished',
          toolFinished({
            result: { balance: '£1,204.55', accountNumber: '12345678' },
            message: 'The customer webhook did not confirm the operation.',
            request: { url: 'https://tenant.example/hooks', body: 'secret' },
          }),
        ),
      ),
    ).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'success',
        durationMs: 412,
      },
    });
  });

  it.each([
    ['tool is missing', toolFinished({ tool: undefined })],
    ['tool is not a string', toolFinished({ tool: { name: 'lookup_order' } })],
    ['invocationId is missing', toolFinished({ invocationId: undefined })],
    ['invocationId is not a string', toolFinished({ invocationId: 1 })],
    ['outcome is missing', toolFinished({ outcome: undefined })],
    ['outcome is the wrong case', toolFinished({ outcome: 'SUCCESS' })],
    ['outcome is outside the enum', toolFinished({ outcome: 'pending' })],
    ['outcome is a boolean', toolFinished({ outcome: true })],
    ['durationMs is missing', toolFinished({ durationMs: undefined })],
    ['durationMs is negative', toolFinished({ durationMs: -1 })],
    ['durationMs is NaN', toolFinished({ durationMs: Number.NaN })],
    ['durationMs is Infinity', toolFinished({ durationMs: Number.POSITIVE_INFINITY })],
    ['durationMs is a numeric string', toolFinished({ durationMs: '412' })],
    ['durationMs is null', toolFinished({ durationMs: null })],
  ])('degrades to the envelope when %s', (_label, payload) => {
    expect(project(row('tool_finished', payload))).toStrictEqual(envelope('tool_finished'));
  });
});

describe('the tool_finished status code', () => {
  it.each([
    ['the lowest informational code', 100],
    ['a success code', 200],
    ['a client error', 404],
    ['a server error', 502],
    ['the highest code', 599],
  ])('keeps %s', (_label, status) => {
    expect(project(row('tool_finished', toolFinished({ status })))).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'success',
        durationMs: 412,
        status,
      },
    });
  });

  /**
   * A present-but-invalid optional field degrades the whole event rather than
   * being quietly dropped.
   *
   * One rule — the shape matches exactly or the payload is not shown — beats
   * two, and the alternative is worse than it looks: silently discarding the
   * bad field renders a tool card that reads as complete while one of its
   * facts has vanished, which is the kind of half-truth an operator debugging
   * a failing webhook will act on. An **absent** status is a different thing
   * and stays valid; it is the `?` in the type.
   */
  it.each([
    ['below the range', 99],
    ['above the range', 600],
    ['zero', 0],
    ['fractional', 200.5],
    ['a numeric string', '200'],
    ['null', null],
    ['NaN', Number.NaN],
    ['a boolean', true],
  ])('degrades to the envelope when status is %s', (_label, status) => {
    expect(project(row('tool_finished', toolFinished({ status })))).toStrictEqual(
      envelope('tool_finished'),
    );
  });
});

describe('the tool_finished error category', () => {
  const codes = Object.keys(ERROR_CATEGORY_LABELS);

  function categoryOf(errorCategory: unknown): string | undefined {
    const projected = project(
      row('tool_finished', toolFinished({ outcome: 'failure', errorCategory })),
    );

    return (projected.payload as { errorCategory?: string } | undefined)?.errorCategory;
  }

  it('mirrors exactly the six codes webhooks.py can emit', () => {
    expect(codes).toHaveLength(6);
  });

  it.each(Object.entries(ERROR_CATEGORY_LABELS))('shows %s as its label', (code, label) => {
    expect(
      project(row('tool_finished', toolFinished({ outcome: 'failure', errorCategory: code }))),
    ).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'failure',
        durationMs: 412,
        errorCategory: label,
      },
    });
  });

  /**
   * The table above is the real assertion, but on its own it would also pass
   * against a map that returned "Failed" for everything — the generic label is
   * the correct answer for one of the six, so a collapsed map is only visible
   * when the six are compared against each other.
   */
  it('gives each of the six a label distinct from the other five', () => {
    const labels = codes.map(categoryOf);

    expect(new Set(labels).size, 'the label map collapsed distinct codes together').toBe(6);
  });

  it.each(codes)('never shows the raw %s code', (code) => {
    const projected = project(
      row('tool_finished', toolFinished({ outcome: 'failure', errorCategory: code })),
    );

    expect(JSON.stringify(projected)).not.toContain(code);
  });

  /**
   * The rule that matters for an agent build newer than this app: a code the
   * map has not heard of shows the generic label rather than falling back to
   * the raw string, which is how the internal vocabulary would otherwise reach
   * a tenant one deploy after someone added a case to `deliver`.
   *
   * The near-misses are the interesting half. A map keyed on the exact string
   * is correct, and a lookup that trimmed or lowercased its input to be
   * "helpful" would be the thing that turned a typo in the agent into a label
   * that looked authoritative.
   */
  it.each([
    'webhook_quota_exhausted',
    'webhook_tls_handshake_failed',
    'WEBHOOK_UNREACHABLE',
    'webhook_unreachable ',
    'Unreachable',
    '',
  ])('labels the unrecognised "%s" as Failed', (code) => {
    expect(
      project(row('tool_finished', toolFinished({ outcome: 'failure', errorCategory: code }))),
    ).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'failure',
        durationMs: 412,
        errorCategory: 'Failed',
      },
    });
  });

  /**
   * A guard against the map's own keys being reachable through `errorCategory`.
   * `Object.prototype` is on every object literal, so a plain `map[code]`
   * lookup answers `toString` with a function and `constructor` with `Object`
   * — neither of which is a label, and both of which would reach the page.
   */
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'does not resolve the inherited %s to anything but Failed',
    (code) => {
      expect(categoryOf(code)).toBe('Failed');
    },
  );

  it.each([
    ['a number', 500],
    ['null', null],
    ['an object', { code: 'webhook_unreachable' }],
    ['an array', ['webhook_unreachable']],
    ['a boolean', false],
  ])('degrades to the envelope when errorCategory is %s', (_label, errorCategory) => {
    expect(
      project(row('tool_finished', toolFinished({ outcome: 'failure', errorCategory }))),
    ).toStrictEqual(envelope('tool_finished'));
  });

  it('keeps status and errorCategory together on a real HTTP failure', () => {
    expect(
      project(
        row(
          'tool_finished',
          toolFinished({
            outcome: 'failure',
            status: 503,
            errorCategory: 'webhook_http_error',
          }),
        ),
      ),
    ).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'failure',
        durationMs: 412,
        status: 503,
        errorCategory: 'HTTP error',
      },
    });
  });
});

describe('every other event type', () => {
  /**
   * `delegation_created` is the case to read: it has a real payload key that
   * `reporting.py` documents, and it is still envelope-only here, because the
   * call detail has nothing to say about a delegation id. A whitelist is a
   * list of things worth showing, not a list of things known to be safe.
   */
  it.each([
    ['delegation_created', { delegationId: 'del-0001' }],
    ['bot_speech_started', {}],
    ['bot_speech_stopped', {}],
    ['interruption', {}],
  ])('projects %s as the envelope alone', (type, payload) => {
    expect(project(row(type, payload))).toStrictEqual(envelope(type));
  });

  /**
   * An unknown type carrying a payload shaped exactly like a known one is the
   * case that separates "switch on type, then pick keys" from "look for keys
   * that happen to be there". Only the first gets this right.
   */
  it('projects an unknown type as the envelope even when its payload looks valid', () => {
    expect(
      project(row('transcript_supervisor', { text: 'this type does not exist yet' })),
    ).toStrictEqual(envelope('transcript_supervisor'));
  });

  it.each([
    ['tool_finished with an s', 'tool_finisheds'],
    ['the wrong case', 'TRANSCRIPT_USER'],
    ['the empty string', ''],
    ['a hyphenated near-miss', 'transcript-user'],
  ])('projects %s as the envelope', (_label, type) => {
    expect(project(row(type, toolFinished()))).toStrictEqual(envelope(type));
  });
});

describe('a payload that is not an object', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'transcript_user'],
    ['a JSON string of a valid payload', '{"text":"I need to change my address."}'],
    ['a number', 42],
    ['a boolean', false],
    ['an array', [{ text: 'first' }]],
    ['an empty array', []],
  ])('degrades %s to the envelope on a known type', (_label, payload) => {
    expect(project(row('transcript_user', payload))).toStrictEqual(envelope('transcript_user'));
  });

  it('degrades an empty object to the envelope', () => {
    expect(project(row('tool_started', {}))).toStrictEqual(envelope('tool_started'));
  });
});

describe('the whitelist never spreads the stored payload', () => {
  /**
   * The behavioural proof, rather than a reading of the source.
   *
   * A spread reads every enumerable own key, so an unlisted key whose getter
   * throws turns `{ ...payload }` into an exception and a blank call detail.
   * A projection that names `text` and copies it never touches the trap. This
   * is also the sharpest test of "never throws": the input is hostile rather
   * than merely wrong.
   */
  function withTrap(known: Record<string, unknown>): Record<string, unknown> {
    const payload = { ...known };

    Object.defineProperty(payload, 'providerMetadata', {
      enumerable: true,
      get() {
        throw new Error('the projection enumerated an unlisted key');
      },
    });

    return payload;
  }

  it('does not read an unlisted key on a transcript', () => {
    expect(project(row('transcript_user', withTrap({ text: 'kept' })))).toStrictEqual({
      ...envelope('transcript_user'),
      payload: { text: 'kept' },
    });
  });

  it('does not read an unlisted key on tool_finished', () => {
    expect(project(row('tool_finished', withTrap(toolFinished())))).toStrictEqual({
      ...envelope('tool_finished'),
      payload: {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'success',
        durationMs: 412,
      },
    });
  });

  it('does not read an unlisted key on a type it will not project at all', () => {
    expect(
      project(row('delegation_created', withTrap({ delegationId: 'del-1' }))),
    ).toStrictEqual(envelope('delegation_created'));
  });

  it('proves the trap fires against the spread it is guarding', () => {
    const payload = withTrap({ text: 'kept' });

    expect(() => ({ ...payload })).toThrow('enumerated an unlisted key');
  });
});

describe('the assistant snapshot never reaches the projection', () => {
  const CANARY = 'assistant-snapshot-canary-8f21c6';

  /**
   * `calls.assistant_snapshot` holds the tenant's instructions and their
   * encrypted server secret. It is a column on `calls`, not on `call_events`,
   * so it has no honest route into an event payload — which is exactly why it
   * is worth asserting: the failure mode is a future join or a debugging field
   * that attaches it, and by then nothing would be watching.
   */
  function snapshotBearingPayload(known: Record<string, unknown>): Record<string, unknown> {
    return {
      ...known,
      assistant_snapshot: { instructions: CANARY, serverSecretCiphertext: CANARY },
      assistantSnapshot: { backendInstructions: CANARY },
      snapshot: CANARY,
    };
  }

  it.each([
    ['transcript_user', { text: 'kept' } as Record<string, unknown>, { text: 'kept' }],
    [
      'tool_finished',
      toolFinished() as Record<string, unknown>,
      {
        tool: 'lookup_order',
        invocationId: 'inv-0001',
        outcome: 'success',
        durationMs: 412,
      },
    ],
  ])('strips it from %s while keeping the fields that belong', (type, known, expected) => {
    const projected = project(row(type, snapshotBearingPayload(known)));

    // Both halves are needed. The canary's absence alone would also be
    // satisfied by a projection that dropped the payload entirely, which is
    // the wrong behaviour passing the right assertion.
    expect(JSON.stringify(projected)).not.toContain(CANARY);
    expect(projected).toStrictEqual({ ...envelope(type), payload: expected });
  });

  it('proves the canary is detectable, so its absence above is not vacuous', () => {
    const leaked = JSON.stringify({
      ...envelope('transcript_user'),
      payload: snapshotBearingPayload({ text: 'kept' }),
    });

    expect(leaked).toContain(CANARY);
  });
});

describe('a whole call, projected', () => {
  /**
   * The list-level guarantee. A call detail renders every row the query
   * returned, in `seq` order, so a malformed payload in the middle must cost
   * that event its payload and nothing else — not the events around it, not
   * the ordering, and not the page.
   */
  const rows = [
    row('transcript_user', { text: 'Where is my order?' }, 1),
    row('tool_started', { tool: 'lookup_order', invocationId: 'inv-0001' }, 2),
    row('tool_finished', toolFinished({ durationMs: -3 }), 3),
    row('delegation_created', { delegationId: 'del-0001' }, 4),
    row('transcript_assistant', { text: null }, 5),
    row('interruption', null, 6),
    row('mystery_event', { text: 'from a newer agent build' }, 7),
    row('transcript_assistant', { text: 'It ships tomorrow.' }, 8),
  ];

  it('keeps one output per input, in order, with no throw', () => {
    const projected = rows.map(projectWorkspaceCallEvent);

    expect(projected).toHaveLength(rows.length);
    expect(projected.map((event) => event.seq)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(projected.map((event) => event.type)).toStrictEqual(rows.map((event) => event.type));
  });

  it('degrades only the events that earned it', () => {
    const withPayload = rows
      .map(projectWorkspaceCallEvent)
      .filter((event) => 'payload' in event)
      .map((event) => event.seq);

    expect(withPayload).toStrictEqual([1, 2, 8]);
  });

  /**
   * The call detail pairs a tool card to its `tool_started` on `invocationId`,
   * so the id has to survive both halves of the pair or the card cannot be
   * built at all.
   */
  it('keeps the invocation id on both halves of a tool pair', () => {
    const projected = [
      row('tool_started', { tool: 'lookup_order', invocationId: 'inv-0001' }, 2),
      row('tool_finished', toolFinished({ invocationId: 'inv-0001' }), 3),
    ].map(projectWorkspaceCallEvent);

    expect(
      projected.map(
        (event) => (event.payload as { invocationId?: string } | undefined)?.invocationId,
      ),
    ).toStrictEqual(['inv-0001', 'inv-0001']);
  });
});
