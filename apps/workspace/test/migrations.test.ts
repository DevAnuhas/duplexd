import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"

import { beforeAll, describe, expect, it } from "vitest"

import { applyMigrations as applyApplicationMigrations } from "@/db/migrate"

import {
  dropAllSchemas,
  EXPECTED_TABLES,
  withTestPool,
} from "./helpers/database.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

/**
 * Migrations from a genuinely empty database, and idempotent on a second run.
 *
 * **This file drops and recreates schemas.** It only ever touches the database
 * named by `DATABASE_URL`, through the same `requireDatabaseUrl()` guard the
 * application uses, so it cannot reach a local default. `vitest.config.ts`
 * disables file parallelism specifically so this cannot run alongside another
 * database-backed file and delete the rows it is asserting about.
 *
 * "Empty" is the contract's definition: `public` dropped and recreated **and**
 * the `drizzle` schema holding `__drizzle_migrations` dropped. Dropping only
 * `public` would leave the ledger behind, `migrate()` would conclude it had
 * already run everything, and this suite would happily verify a database with
 * no tables in it.
 */

type IndexRow = { indexname: string; indexdef: string }

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

describeDatabase("migrations from an empty database", () => {
  let indexes: IndexRow[] = []
  let tables: string[] = []
  let firstReport = { before: -1, after: -1, applied: -1 }

  beforeAll(async () => {
    // Unguarded against skipping, on purpose: if DATABASE_URL is set and this
    // fails, the run fails and never downgrades to a skip. It does go through
    // `dropAllSchemas`, which is the one place that refuses to wipe the
    // database `.env.local` names.
    await dropAllSchemas()
    firstReport = await applyApplicationMigrations()

    ;({ indexes, tables } = await withTestPool(async (pool) => {
      const tableRows = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`
      )
      const indexRows = await pool.query<IndexRow>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`
      )

      return {
        tables: tableRows.rows.map((row) => row.table_name),
        indexes: indexRows.rows,
      }
    }))
  })

  it("creates every table in the data model", () => {
    for (const table of EXPECTED_TABLES) {
      expect(tables, `missing table: ${table}`).toContain(table)
    }
  })

  it("creates no table the data model does not name", () => {
    expect([...tables].sort()).toStrictEqual([...EXPECTED_TABLES].sort())
  })

  it("records the migration in the drizzle ledger", async () => {
    const applied = await withTestPool(async (pool) => {
      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
      )

      return Number(rows[0]?.count ?? 0)
    })

    expect(applied).toBeGreaterThan(0)
    expect(firstReport).toStrictEqual({
      before: 0,
      after: applied,
      applied,
    })
  })

  describe("indexes from the data model", () => {
    function definitionOf(name: string): string {
      const found = indexes.find((row) => row.indexname === name)

      expect(found, `missing index: ${name}`).toBeDefined()

      return found?.indexdef ?? ""
    }

    it("indexes api_keys (prefix) uniquely", () => {
      expect(definitionOf("api_keys_prefix_idx")).toMatch(
        /CREATE UNIQUE INDEX/i
      )
      expect(definitionOf("api_keys_prefix_idx")).toMatch(/\(prefix\)/i)
    })

    it("indexes calls (account_id, created_at desc)", () => {
      const definition = definitionOf("calls_account_created_idx")

      expect(definition).toMatch(/account_id/)
      expect(definition).toMatch(/created_at DESC/i)
    })

    it("indexes calls by API key for attribution checks and foreign-key maintenance", () => {
      expect(definitionOf("calls_api_key_idx")).toMatch(/\(api_key_id\)/i)
    })

    it("indexes calls (state) partially, for active calls only", () => {
      const definition = definitionOf("calls_active_idx")

      expect(definition).toMatch(/\(state\)/i)
      expect(definition).toMatch(/WHERE .*state = 'active'/i)
    })

    it("indexes starting calls separately for expiry sweeps", () => {
      const definition = definitionOf("calls_starting_idx")

      expect(definition).toMatch(/\(state\)/i)
      expect(definition).toMatch(/WHERE .*state = 'starting'/i)
    })

    it("requires each stored agent-token digest to identify one call", () => {
      const definition = definitionOf("calls_agent_token_hash_idx")

      expect(definition).toMatch(/CREATE UNIQUE INDEX/i)
      expect(definition).toMatch(/\(agent_token_hash\)/i)
    })

    it("adds the Sandbox ownership, idempotency, slot, and expiry indexes", () => {
      const definition = (name: string) =>
        definitionOf(name).replaceAll('"', "")

      expect(definition("sandbox_attempts_owner_client_idx")).toMatch(
        /CREATE UNIQUE INDEX.*\(account_id, initiated_by_user_id, client_attempt_id\)/i
      )
      expect(definition("sandbox_attempts_call_idx")).toMatch(
        /CREATE UNIQUE INDEX.*\(call_id\)/i
      )
      expect(definition("sandbox_attempts_account_state_idx")).toMatch(
        /\(account_id, state\)/i
      )
      expect(definition("sandbox_attempts_reservation_expiry_idx")).toMatch(
        /\(reservation_expires_at\)/i
      )
      expect(definition("sandbox_slots_attempt_idx")).toMatch(
        /CREATE UNIQUE INDEX.*\(attempt_id\)/i
      )
      expect(definition("sandbox_slots_account_idx")).toMatch(/\(account_id\)/i)
    })

    it("allows pre-dispatch calls to have no agent credential while keeping provenance non-null", async () => {
      const columns = await withTestPool(async (pool) => {
        const { rows } = await pool.query<{
          column_name: string
          is_nullable: string
          column_default: string | null
        }>(
          `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'calls'
             AND column_name = ANY($1::text[])`,
          [["agent_token_hash", "source", "channel", "initiated_by_user_id"]]
        )
        return new Map(rows.map((row) => [row.column_name, row]))
      })

      expect(columns.get("agent_token_hash")?.is_nullable).toBe("YES")
      expect(columns.get("initiated_by_user_id")?.is_nullable).toBe("YES")
      expect(columns.get("source")).toMatchObject({
        is_nullable: "NO",
        column_default: "'integration'::text",
      })
      expect(columns.get("channel")).toMatchObject({
        is_nullable: "NO",
        column_default: "'browser'::text",
      })
    })

    it("keeps Sandbox identity required and permits only encrypted join credentials", async () => {
      const columns = await withTestPool(async (pool) => {
        const { rows } = await pool.query<{
          column_name: string
          is_nullable: string
        }>(
          `SELECT column_name, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sandbox_attempts'
           ORDER BY column_name`
        )
        return rows
      })

      expect(columns.map((column) => column.column_name)).toStrictEqual(
        [
          "account_id",
          "call_id",
          "canceled_at",
          "client_attempt_id",
          "controller_proof_hash",
          "dispatched_at",
          "dispatch_settled_at",
          "ready_at",
          "reconciled_at",
          "protocol",
          "resource_state",
          "startup_deadline",
          "presence_expires_at",
          "runtime_session_id",
          "runtime_boot_id",
          "join_ciphertext",
          "join_expires_at",
          "reporting_until",
          "identity_conflict_at",
          "expired_at",
          "id",
          "initiated_by_user_id",
          "input_digest",
          "prepared_at",
          "reservation_expires_at",
          "state",
          "stop_reason",
          "stop_requested_at",
        ].sort()
      )
      const nullability = new Map(
        columns.map((column) => [column.column_name, column.is_nullable])
      )
      for (const required of [
        "account_id",
        "call_id",
        "client_attempt_id",
        "controller_proof_hash",
        "id",
        "input_digest",
        "prepared_at",
        "reservation_expires_at",
        "state",
      ]) {
        expect(nullability.get(required), required).toBe("NO")
      }
      expect(
        columns
          .map((column) => column.column_name)
          .filter((name) =>
            /token|credential|room|secret|ciphertext|plaintext/i.test(name)
          )
      ).toStrictEqual(["join_ciphertext"])
    })

    it("gives call_events a composite primary key on (call_id, seq)", async () => {
      const key = await withTestPool(async (pool) => {
        const { rows } = await pool.query<{ column_name: string }>(
          `SELECT a.attname AS column_name
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
           WHERE t.relname = 'call_events' AND c.contype = 'p'
           ORDER BY k.ord`
        )

        return rows.map((row) => row.column_name)
      })

      expect(key).toStrictEqual(["call_id", "seq"])
    })
  })

  /**
   * The second run. Drizzle records what it has applied, so this must be a
   * no-op rather than an error — a deploy that ran migrations twice would
   * otherwise fail the second time and take the release with it.
   */
  it("is idempotent on a second run, with no change to the schema", async () => {
    const before = await snapshot()

    const second = await applyApplicationMigrations()

    expect(second.applied).toBe(0)
    expect(second.after).toBe(second.before)

    expect(await snapshot()).toStrictEqual(before)
  })
})

/** Tables, columns and indexes, as a comparable shape. */
async function snapshot(): Promise<{
  columns: string[]
  indexes: string[]
  migrations: number
}> {
  return withTestPool(async (pool) => {
    const columns = await pool.query<{ signature: string }>(
      `SELECT table_name || '.' || column_name || ':' || data_type ||
              ':' || is_nullable AS signature
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY signature`
    )
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexdef`
    )
    const migrations = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    )

    return {
      columns: columns.rows.map((row) => row.signature),
      indexes: indexes.rows.map((row) => row.indexdef),
      migrations: Number(migrations.rows[0]?.count ?? 0),
    }
  })
}

describeDatabase(
  "additive A04 migration over existing Integration data",
  () => {
    it("preserves legacy call/event records and leaves new event metadata nullable", async () => {
      const source = fileURLToPath(new URL("../drizzle/", import.meta.url))
      const staging = await mkdtemp(join(tmpdir(), "duplexd-a04-migration-"))
      const journal = JSON.parse(
        await readFile(join(source, "meta/_journal.json"), "utf8")
      ) as {
        entries: Array<{ tag: string; idx: number; when: number }>
      }
      const a04 = journal.entries.findIndex(
        (entry) => entry.tag === "0007_famous_iron_man"
      )
      expect(a04).toBe(7)
      const old = { ...journal, entries: journal.entries.slice(0, a04) }
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(staging, "meta"))
      await writeFile(join(staging, "meta/_journal.json"), JSON.stringify(old))
      for (const entry of old.entries)
        await copyFile(
          join(source, `${entry.tag}.sql`),
          join(staging, `${entry.tag}.sql`)
        )
      const accountId = randomUUID()
      const callId = randomUUID()
      try {
        await withTestPool(async (pool) => {
          await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE")
          await pool.query("DROP SCHEMA IF EXISTS public CASCADE")
          await pool.query("CREATE SCHEMA public")
          await migrate(drizzle(pool), { migrationsFolder: staging })
          await pool.query(
            "INSERT INTO accounts (id, name) VALUES ($1, 'synthetic migration account')",
            [accountId]
          )
          await pool.query(
            `INSERT INTO calls (id, account_id, assistant_snapshot, state, duration_secs)
          VALUES ($1, $2, '{}', 'ended', 12.345)`,
            [callId, accountId]
          )
          await pool.query(
            `INSERT INTO call_events (call_id, seq, at, type, payload)
          VALUES ($1, 1, '2026-09-22T00:00:00Z', 'transcript_user', '{"text":"synthetic historical event"}')`,
            [callId]
          )
        })
        expect(await applyApplicationMigrations()).toEqual({
          before: 7,
          after: 8,
          applied: 1,
        })
        await withTestPool(async (pool) => {
          const call = await pool.query(
            "SELECT state, source, duration_secs FROM calls WHERE id = $1",
            [callId]
          )
          expect(call.rows).toEqual([
            { state: "ended", source: "integration", duration_secs: "12.345" },
          ])
          const events = await pool.query(
            "SELECT seq, payload, ingest_cursor, content_digest, byte_length FROM call_events WHERE call_id = $1",
            [callId]
          )
          expect(events.rows).toEqual([
            {
              seq: 1,
              payload: { text: "synthetic historical event" },
              ingest_cursor: null,
              content_digest: null,
              byte_length: null,
            },
          ])
          expect(
            (
              await pool.query(
                "SELECT * FROM sandbox_evidence WHERE call_id = $1",
                [callId]
              )
            ).rows
          ).toEqual([])
        })
        expect((await applyApplicationMigrations()).applied).toBe(0)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    })
  }
)
