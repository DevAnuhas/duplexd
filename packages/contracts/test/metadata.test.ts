import { describe, expect, it } from 'vitest';

import { CONTRACT_VERSION, checkHandlerRequestMetadata } from '@duplexd/contracts';

import { loadMetadataFixtures } from './support/fixtures.js';

const fixtures = loadMetadataFixtures();

/** Every case the spec and contract require a fixture for. */
const REQUIRED_FIXTURES = [
  'valid',
  'session-changed',
  'session-missing',
  'session-duplicated',
  'version-changed',
  'version-missing',
  'version-duplicated',
  'body-session-changed',
  'unsupported-version',
  'case-insensitive-and-comma-id',
] as const;

const bodyFieldsOf = (fixture: { body: { contractVersion: string; sessionId: string } }) => ({
  contractVersion: fixture.body.contractVersion,
  sessionId: fixture.body.sessionId,
});

describe('metadata fixture inventory', () => {
  it('covers every required case', () => {
    for (const name of REQUIRED_FIXTURES) {
      expect(fixtures.has(name), `fixtures/metadata/${name}.json is missing`).toBe(true);
    }
  });

  it('covers each header independently changed, missing and duplicated', () => {
    for (const header of ['session', 'version']) {
      for (const mutation of ['changed', 'missing', 'duplicated']) {
        expect(fixtures.has(`${header}-${mutation}`), `${header}-${mutation}`).toBe(true);
      }
    }
  });

  it('gives every fixture an explicit expectation', () => {
    for (const [name, fixture] of fixtures) {
      expect(fixture.expected?.helper, `${name} has no helper expectation`).toBeDefined();
    }
  });
});

describe('checkHandlerRequestMetadata', () => {
  it.each([...fixtures])('%s matches its recorded helper expectation', (_name, fixture) => {
    const result = checkHandlerRequestMetadata(fixture.rawHeaders, bodyFieldsOf(fixture));
    if (fixture.expected.helper.ok === true) {
      expect(result).toEqual({ ok: true });
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(fixture.expected.helper.status);
    expect(result.code).toBe(fixture.expected.helper.code);
  });

  it('returns only the specified result union', () => {
    for (const [name, fixture] of fixtures) {
      const result = checkHandlerRequestMetadata(fixture.rawHeaders, bodyFieldsOf(fixture));
      if (result.ok) {
        expect(Object.keys(result), name).toEqual(['ok']);
      } else {
        expect(Object.keys(result).sort(), name).toEqual(['code', 'detail', 'ok', 'status']);
        expect(result.status).toBe(400);
        expect(['metadata_mismatch', 'unsupported_contract_version']).toContain(result.code);
      }
    }
  });

  it('compares header names case-insensitively', () => {
    const body = { contractVersion: CONTRACT_VERSION, sessionId: 'session_fixture_1' };
    for (const names of [
      ['duplexd-contract-version', 'duplexd-session-id'],
      ['DUPLEXD-CONTRACT-VERSION', 'DUPLEXD-SESSION-ID'],
      ['Duplexd-Contract-Version', 'Duplexd-Session-Id'],
      ['dUpLeXd-CoNtRaCt-VeRsIoN', 'dUpLeXd-SeSsIoN-iD'],
    ]) {
      const headers: Array<[string, string]> = [
        [names[0] ?? '', body.contractVersion],
        [names[1] ?? '', body.sessionId],
      ];
      expect(checkHandlerRequestMetadata(headers, body), names.join('/')).toEqual({ ok: true });
    }
  });

  it('compares header values exactly', () => {
    const body = { contractVersion: CONTRACT_VERSION, sessionId: 'Session_Fixture_1' };
    const headers = (sessionId: string): Array<[string, string]> => [
      ['duplexd-contract-version', body.contractVersion],
      ['duplexd-session-id', sessionId],
    ];
    expect(checkHandlerRequestMetadata(headers('Session_Fixture_1'), body)).toEqual({ ok: true });
    for (const wrong of ['session_fixture_1', ' Session_Fixture_1', 'Session_Fixture_1 ', '']) {
      expect(checkHandlerRequestMetadata(headers(wrong), body).ok, JSON.stringify(wrong)).toBe(false);
    }
  });

  it('treats a comma-bearing session id as one opaque value', () => {
    // A single header field whose value happens to contain a comma is one
    // value, not two — nothing here splits on commas.
    const body = { contractVersion: CONTRACT_VERSION, sessionId: 'opaque,id' };
    expect(
      checkHandlerRequestMetadata(
        [
          ['duplexd-contract-version', CONTRACT_VERSION],
          ['duplexd-session-id', 'opaque,id'],
        ],
        body,
      ),
    ).toEqual({ ok: true });
    // Two real header fields joined the way Fetch would are still a duplicate.
    expect(
      checkHandlerRequestMetadata(
        [
          ['duplexd-contract-version', CONTRACT_VERSION],
          ['duplexd-session-id', 'opaque'],
          ['duplexd-session-id', 'id'],
        ],
        body,
      ).ok,
    ).toBe(false);
  });

  it('requires each header exactly once, even when the duplicates agree', () => {
    const body = { contractVersion: CONTRACT_VERSION, sessionId: 'session_fixture_1' };
    const result = checkHandlerRequestMetadata(
      [
        ['duplexd-contract-version', CONTRACT_VERSION],
        ['duplexd-session-id', body.sessionId],
        ['duplexd-session-id', body.sessionId],
      ],
      body,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('metadata_mismatch');
  });

  it('names the offending header in safe detail', () => {
    const body = { contractVersion: CONTRACT_VERSION, sessionId: 'session_fixture_1' };
    const sessionMismatch = checkHandlerRequestMetadata(
      [
        ['duplexd-contract-version', CONTRACT_VERSION],
        ['duplexd-session-id', 'another-session'],
      ],
      body,
    );
    expect(sessionMismatch.ok).toBe(false);
    if (!sessionMismatch.ok) {
      expect(sessionMismatch.detail).toContain('duplexd-session-id');
      // Safe detail: the header's name, never the value that failed.
      expect(sessionMismatch.detail).not.toContain('another-session');
      expect(sessionMismatch.detail).not.toContain(body.sessionId);
    }

    const versionMismatch = checkHandlerRequestMetadata(
      [
        ['duplexd-contract-version', '0'],
        ['duplexd-session-id', body.sessionId],
      ],
      body,
    );
    expect(versionMismatch.ok).toBe(false);
    if (!versionMismatch.ok) expect(versionMismatch.detail).toContain('duplexd-contract-version');
  });

  it('checks header equality before supported version', () => {
    // A body version of "0" with a header that does not match it is a
    // mismatch, not an unsupported version: step 3 runs before step 4.
    const body = { contractVersion: '0', sessionId: 'session_fixture_1' };
    const mismatch = checkHandlerRequestMetadata(
      [
        ['duplexd-contract-version', CONTRACT_VERSION],
        ['duplexd-session-id', body.sessionId],
      ],
      body,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe('metadata_mismatch');

    // With the header agreeing, the same body reaches the version check.
    const unsupported = checkHandlerRequestMetadata(
      [
        ['duplexd-contract-version', '0'],
        ['duplexd-session-id', body.sessionId],
      ],
      body,
    );
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.code).toBe('unsupported_contract_version');
  });

  it('ignores unrelated headers entirely', () => {
    const body = { contractVersion: CONTRACT_VERSION, sessionId: 'session_fixture_1' };
    expect(
      checkHandlerRequestMetadata(
        [
          ['host', 'handler.example.com'],
          ['content-type', 'application/json'],
          ['duplexd-contract-version', CONTRACT_VERSION],
          ['x-duplexd-session-id', 'decoy'],
          ['duplexd-session-id', body.sessionId],
        ],
        body,
      ),
    ).toEqual({ ok: true });
  });

  it('structurally cannot report a signature outcome', () => {
    // It receives neither the secret nor the raw bytes, so `invalid_signature`
    // is not in its vocabulary; that belongs to verifyHandlerSignature.
    const codes = new Set<string>();
    for (const [, fixture] of fixtures) {
      const result = checkHandlerRequestMetadata(fixture.rawHeaders, bodyFieldsOf(fixture));
      if (!result.ok) codes.add(result.code);
    }
    expect(codes.has('invalid_signature')).toBe(false);
    expect([...codes].sort()).toEqual(['metadata_mismatch', 'unsupported_contract_version']);
  });

  it('records both scopes for the changed-body-session fixture', () => {
    // The helper sees a real mismatch; the full pipeline never gets that far,
    // because the tampered bytes fail signature verification at step 1.
    const fixture = fixtures.get('body-session-changed');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    expect(fixture.expected.helper).toEqual({ status: 400, code: 'metadata_mismatch' });
    expect(fixture.expected.handler).toEqual({
      status: 401,
      code: 'invalid_signature',
      helperCalled: false,
    });
    expect(checkHandlerRequestMetadata(fixture.rawHeaders, bodyFieldsOf(fixture))).toEqual({
      ok: false,
      status: 400,
      code: 'metadata_mismatch',
      detail: expect.stringContaining('duplexd-session-id'),
    });
  });
});
