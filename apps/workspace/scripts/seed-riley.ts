import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { eq, sql } from "drizzle-orm"

import { closeDb, getDb } from "../src/db/client.ts"
import { assistants, users } from "../src/db/schema.ts"
import { validateServerUrl, validateTools } from "../src/lib/validate.ts"
import { rileyDemo, rileyDemoId } from "./riley-demo.ts"

class SeedInputError extends Error {}

export function parseSeedArgs(args: string[]) {
  let values
  try {
    ;({ values } = parseArgs({
      args,
      options: {
        apply: { type: "boolean", default: false },
        "owner-email": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch {
    throw new SeedInputError(
      "Usage: pnpm seed:riley [--apply --owner-email you@example.com]"
    )
  }
  const ownerEmail = values["owner-email"]?.trim().toLowerCase()
  if (!values.help && !values.apply && values["owner-email"] !== undefined) {
    throw new SeedInputError(
      "--owner-email requires --apply. Omit both to preview."
    )
  }
  if (!values.help && values.apply && !ownerEmail) {
    throw new SeedInputError(
      "--apply requires --owner-email for an existing workspace user."
    )
  }
  return { apply: values.apply, help: values.help, ownerEmail }
}

export function validatedRileyDemo() {
  const config = rileyDemo()
  const validation = validateTools(config.tools)
  const urlIssue = validateServerUrl(config.serverUrl)
  if (urlIssue) validation.push(urlIssue)
  if (validation.length > 0)
    throw new SeedInputError(
      `The demo configuration is invalid: ${validation.map((issue) => issue.message).join(" ")}`
    )
  return config
}

/** Insert only. An edited, connected, or archived seed is never overwritten. */
export async function seedRiley(ownerEmail: string) {
  const config = validatedRileyDemo()

  return getDb().transaction(async (tx) => {
    const owners = await tx
      .select({ accountId: users.accountId })
      .from(users)
      .where(sql`lower(${users.email}) = ${ownerEmail.trim().toLowerCase()}`)
      .limit(2)
    if (owners.length === 0) {
      throw new SeedInputError(
        "No workspace user matches --owner-email. Sign up first or check the email and target database."
      )
    }
    if (owners.length > 1) {
      throw new SeedInputError(
        "Multiple workspace users match this email ignoring case. Resolve the account ambiguity before seeding."
      )
    }
    const accountId = owners[0]!.accountId
    const id = rileyDemoId(accountId)
    const inserted = await tx
      .insert(assistants)
      .values({ ...config, id, accountId, serverSecrets: [] })
      .onConflictDoNothing({ target: assistants.id })
      .returning({ id: assistants.id })
    let archived = false
    if (inserted.length === 0) {
      const existing = await tx
        .select({
          accountId: assistants.accountId,
          archivedAt: assistants.archivedAt,
        })
        .from(assistants)
        .where(eq(assistants.id, id))
        .limit(1)
      if (existing[0]?.accountId !== accountId) {
        throw new SeedInputError(
          "The demo identifier is already owned by another account."
        )
      }
      archived = existing[0].archivedAt !== null
    }
    return {
      status: inserted.length
        ? "created"
        : archived
          ? "already_exists_archived"
          : "already_exists",
      assistantId: id,
      accountId,
      editorPath: archived ? null : `/assistants/${id}`,
    }
  })
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseSeedArgs(args)
  if (options.help) {
    console.log(
      "pnpm seed:riley                              # preview, no database connection"
    )
    console.log(
      "pnpm seed:riley --apply --owner-email EMAIL   # insert into that user's account"
    )
    return
  }
  if (!options.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "preview",
          connected: false,
          note: "Proposed demo configuration only; no Boring Host integration or live call. Apply requires an existing workspace owner.",
          assistant: validatedRileyDemo(),
        },
        null,
        2
      )
    )
    return
  }
  try {
    console.log(JSON.stringify(await seedRiley(options.ownerEmail!), null, 2))
    console.log(
      "Existing demo records are preserved, including edits and archived state."
    )
    console.log(
      "New records are disconnected: configure a compatible customer adapter through the workspace before starting a call. See docs/ENGINEERING.md."
    )
  } finally {
    await closeDb()
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    // Database errors can contain customer data or connection credentials.
    console.error(
      error instanceof SeedInputError
        ? error.message
        : "Riley seed failed. Check DATABASE_URL, applied migrations, and database connectivity; underlying error details are withheld."
    )
    process.exitCode = 1
  })
}
