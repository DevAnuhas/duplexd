import { CONTRACT_VERSION } from './constants.js';

export type MetadataCheck =
  | { ok: true }
  | {
      ok: false;
      status: 400;
      code: 'metadata_mismatch' | 'unsupported_contract_version';
      detail: string;
    };

export function checkHandlerRequestMetadata(
  rawHeaders: ReadonlyArray<readonly [string, string]>,
  body: { contractVersion: string; sessionId: string },
): MetadataCheck {
  const valuesFor = (name: string) =>
    rawHeaders
      .filter(([header]) => header.toLowerCase() === name)
      .map(([, value]) => value);

  for (const [name, expected] of [
    ['duplexd-contract-version', body.contractVersion],
    ['duplexd-session-id', body.sessionId],
  ] as const) {
    const values = valuesFor(name);
    if (values.length !== 1 || values[0] !== expected) {
      return {
        ok: false,
        status: 400,
        code: 'metadata_mismatch',
        detail: `${name} must appear exactly once and equal the signed body`,
      };
    }
  }

  if (body.contractVersion !== CONTRACT_VERSION) {
    return {
      ok: false,
      status: 400,
      code: 'unsupported_contract_version',
      detail: 'Body contract version is unsupported',
    };
  }
  return { ok: true };
}
