import { SIGNATURE_TOLERANCE_SECONDS } from './constants.js';

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function importKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signHandlerRequest(
  secret: string,
  body: string,
  now: () => number = Date.now,
): Promise<string> {
  const timestamp = Math.floor(now() / 1000);
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${body}`),
  );
  return `t=${timestamp},v1=${toHex(new Uint8Array(signature))}`;
}

export type SignatureVerification =
  { ok: true } | { ok: false; code: 'invalid_signature' | 'stale_timestamp' };

export async function verifyHandlerSignature(
  secret: string,
  header: string | null,
  body: string,
  options: { now?: () => number; toleranceSeconds?: number } = {},
): Promise<SignatureVerification> {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return { ok: false, code: 'invalid_signature' };

  const timestamp = Number(match[1]);
  const signature = fromHex(match[2] ?? '');
  if (!Number.isSafeInteger(timestamp) || signature === null) {
    return { ok: false, code: 'invalid_signature' };
  }

  let verified: boolean;
  try {
    const key = await importKey(secret);
    verified = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(`${timestamp}.${body}`),
    );
  } catch {
    return { ok: false, code: 'invalid_signature' };
  }
  if (!verified) return { ok: false, code: 'invalid_signature' };

  const now = Math.floor((options.now ?? Date.now)() / 1000);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, code: 'stale_timestamp' };
  }
  return { ok: true };
}
