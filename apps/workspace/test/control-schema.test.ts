import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, getDb } from '@/db/client';
import { calls } from '@/db/schema';

import { withTestPool } from './helpers/database.ts';
import { isDatabaseConfigured } from './helpers/environment.ts';

const describeDatabase = describe.skipIf(!isDatabaseConfigured());

afterAll(async () => {
  await closeDb();
});

describeDatabase('P05 call persistence shape', () => {
  it('stores fractional duration as numeric(12,3)', async () => {
    const column = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{
        data_type: string;
        numeric_precision: number;
        numeric_scale: number;
      }>(
        `SELECT data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'calls'
           AND column_name = 'duration_secs'`,
      );

      return rows[0];
    });

    expect(column, 'duration_secs was absent, so no type was measured').toBeDefined();
    expect(column).toStrictEqual({
      data_type: 'numeric',
      numeric_precision: 12,
      numeric_scale: 3,
    });
  });

  it('has only a hash slot for the agent credential', async () => {
    const columns = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'calls'
         ORDER BY column_name`,
      );

      return rows.map((row) => row.column_name);
    });

    expect(columns, 'the calls table had no columns, so no credential shape was measured')
      .not.toHaveLength(0);
    expect(columns).toContain('agent_token_hash');
    expect(columns).not.toContain('agent_token');
    expect(columns).not.toContain('agent_token_plaintext');
    expect(columns).not.toContain('server_secret');
    expect(columns).not.toContain('server_secret_plaintext');
  });

  it('round-trips 12.345 through the Drizzle mapping as a number', async () => {
    const accountId = randomUUID();
    const callId = randomUUID();

    await withTestPool(async (pool) => {
      await pool.query('INSERT INTO accounts (id, name) VALUES ($1, $2)', [
        accountId,
        'duration mapping control',
      ]);
    });

    await getDb().insert(calls).values({
      id: callId,
      accountId,
      assistantSnapshot: { assistantId: 'snapshot-duration-control' },
      agentTokenHash: '0'.repeat(64),
      state: 'ended',
      durationSecs: 12.345,
    });

    const stored = await getDb().query.calls.findFirst({
      where: (table, operators) => operators.eq(table.id, callId),
      columns: { durationSecs: true },
    });

    expect(stored, 'the inserted call was not readable').toBeDefined();
    expect(typeof stored?.durationSecs).toBe('number');
    expect(stored?.durationSecs).toBe(12.345);
  });
});
