import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb } from '@/db/client';
import * as schema from '@/db/schema';
import { callEvents, calls } from '@/db/schema';

import { openTestPool, withTestPool } from './helpers/database.ts';
import { captureFailure, errorText } from './helpers/error-text.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

describeDatabase('transcript parameter redaction on the P05 event path', () => {
  const callId = randomUUID();
  const accountId = randomUUID();
  const seq = 73;

  beforeAll(async () => {
    await withTestPool(async (pool) => {
      await pool.query('INSERT INTO accounts (id, name) VALUES ($1, $2)', [
        accountId,
        'event redaction control',
      ]);
    });

    await getDb().insert(calls).values({
      id: callId,
      accountId,
      assistantSnapshot: { assistantId: 'redaction-control' },
      agentTokenHash: 'a'.repeat(64),
      state: 'active',
    });
    await getDb().insert(callEvents).values({
      callId,
      seq,
      at: new Date('2026-09-20T10:00:00.123Z'),
      type: 'transcript_user',
      payload: { text: 'first row occupies the key' },
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function collide(
    db: ReturnType<typeof getDb>,
    transcriptCanary: string,
  ): Promise<unknown> {
    return captureFailure(() =>
      db.insert(callEvents).values({
        callId,
        seq,
        at: new Date('2026-09-20T10:00:01.123Z'),
        type: 'transcript_user',
        payload: { text: transcriptCanary },
      }),
    );
  }

  it('proves the collector detects a leak when the inherited wrapper is bypassed', async () => {
    const canary = `unredacted-transcript-${randomUUID()}`;
    const pool = openTestPool();

    try {
      const unwrapped = drizzle(pool, { schema });
      const captured = errorText(await collide(unwrapped as ReturnType<typeof getDb>, canary));

      expect(captured, 'the deliberate bypass did not expose the canary').toContain(canary);
      expect(captured).toContain('call_events');
    } finally {
      await pool.end();
    }
  });

  it('removes transcript values but preserves safe query identity on the real client', async () => {
    const canary = `redacted-transcript-${randomUUID()}`;
    const captured = errorText(await collide(getDb(), canary));

    expect(captured, 'the error capture was blank, so absence would be vacuous').not.toBe('');
    expect(captured).not.toContain(canary);
    expect(captured).toContain('call_events');
    expect(captured).toContain('insert into');
  });
});
