import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 for high-entropy bearer credentials. Never use for passwords. */
export function hashCredential(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A call-scoped credential shown only to Pipecat Cloud's runner body. */
export function mintAgentToken(): { raw: string; hash: string } {
  const raw = `dat_${randomBytes(32).toString('base64url')}`;

  return { raw, hash: hashCredential(raw) };
}
