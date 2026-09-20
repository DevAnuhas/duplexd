import { createHash, randomBytes, randomUUID } from "node:crypto"

import { beforeAll, describe, expect, it } from "vitest"

import { withTestPool } from "./helpers/database.ts"
import { isDatabaseConfigured } from "./helpers/environment.ts"

/**
 * The `api_keys` table.
 *
 * P02 builds the table; minting, constant-time comparison and revocation are
 * P03. So this file asserts the strongest thing the schema surface bears: that
 * the P03 mechanism is possible without a migration, and that **no column
 * anywhere can hold a raw key**.
 *
 * That last one is checked by column inventory rather than by convention,
 * because the failure mode is a column added later and commented "for now".
 *
 * Rows are inserted directly here rather than through signup: the subject is the
 * table's shape, and a signup would only add latency. Cross-account isolation
 * and the real auth path are tested where they belong, in their own files.
 */

const describeDatabase = describe.skipIf(!isDatabaseConfigured())

type ColumnRow = {
  column_name: string
  data_type: string
  is_nullable: string
}

describeDatabase("api_keys stores a hash and a prefix, never a key", () => {
  let columns: ColumnRow[] = []
  let accountId = ""

  beforeAll(async () => {
    columns = await withTestPool(async (pool) => {
      const { rows } = await pool.query<ColumnRow>(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'api_keys'
         ORDER BY column_name`
      )

      return rows
    })

    accountId = randomUUID()

    await withTestPool(async (pool) => {
      await pool.query("INSERT INTO accounts (id, name) VALUES ($1, $2)", [
        accountId,
        "api-keys schema test",
      ])
    })
  })

  function names(): string[] {
    return columns.map((column) => column.column_name)
  }

  it("has the columns the P03 mechanism needs", () => {
    expect(names()).toEqual(
      expect.arrayContaining([
        "id",
        "account_id",
        "name",
        "prefix",
        "key_hash",
        "created_at",
        "revoked_at",
      ])
    )
  })

  it("requires prefix and key_hash", () => {
    for (const required of ["prefix", "key_hash", "account_id"]) {
      const column = columns.find((row) => row.column_name === required)

      expect(column?.is_nullable, `${required} should be NOT NULL`).toBe("NO")
    }
  })

  /** Soft revocation: a revoked key stays inspectable, it does not vanish. */
  it("allows revoked_at to be null", () => {
    expect(
      columns.find((row) => row.column_name === "revoked_at")?.is_nullable
    ).toBe("YES")
  })

  /**
   * The inventory check. Anything that reads as "the key itself" fails, however
   * it is spelled. `key_hash` and `api_key_id` are the two legitimate names that
   * contain the word, so they are excluded by exact match rather than by a
   * looser pattern that a new column could slip through.
   */
  it("has no column that could hold a raw key", () => {
    const allowed = new Set(["key_hash"])
    const suspicious = names().filter(
      (name) =>
        !allowed.has(name) &&
        /(^|_)(key|secret|token|plaintext|raw)(_|$)/.test(name)
    )

    expect(suspicious).toStrictEqual([])
  })

  it("indexes prefix uniquely, enforced by the database", async () => {
    const prefix = `dpx_${randomBytes(6).toString("hex")}`
    const insert = (id: string) =>
      withTestPool(async (pool) => {
        await pool.query(
          `INSERT INTO api_keys (id, account_id, name, prefix, key_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            id,
            accountId,
            "duplicate prefix probe",
            prefix,
            createHash("sha256").update(id).digest("hex"),
          ]
        )
      })

    await insert(randomUUID())
    await expect(insert(randomUUID())).rejects.toThrow(/duplicate key|unique/i)
  })

  /**
   * P03 mints 32 bytes of CSPRNG and stores the SHA-256 of the rendered key.
   * A 64-character hex digest must fit, which a `text` column does; this asserts
   * it round-trips rather than trusting the type name.
   */
  it("stores a full SHA-256 hex digest without truncation", async () => {
    const id = randomUUID()
    const rawKey = `dpx_${randomBytes(32).toString("base64url")}`
    const digest = createHash("sha256").update(rawKey).digest("hex")

    expect(digest).toHaveLength(64)

    const stored = await withTestPool(async (pool) => {
      await pool.query(
        `INSERT INTO api_keys (id, account_id, name, prefix, key_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, accountId, "digest length probe", rawKey.slice(0, 12), digest]
      )

      const { rows } = await pool.query<{ key_hash: string }>(
        "SELECT key_hash FROM api_keys WHERE id = $1",
        [id]
      )

      return rows[0]?.key_hash
    })

    expect(stored).toBe(digest)
  })

  it("scopes every key to an account, with a foreign key", async () => {
    await expect(
      withTestPool(async (pool) => {
        await pool.query(
          `INSERT INTO api_keys (id, account_id, name, prefix, key_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            randomUUID(),
            "no-such-account",
            "orphan probe",
            `dpx_${randomBytes(6).toString("hex")}`,
            createHash("sha256").update("x").digest("hex"),
          ]
        )
      })
    ).rejects.toThrow(/foreign key|violates/i)
  })
})
