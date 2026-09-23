/**
 * Prints the most recent real Sandbox call and its transcript.
 *
 * A convenience for reading back a call you just placed by hand, so the
 * question "did that work?" has an answer that does not depend on the UI.
 * Reads `apps/workspace/.env.local`, so run it from the repository root.
 *
 * "Real" here means the provider session id is a UUID. The test suite runs
 * against the same development database and its fixtures use prefixed
 * identities like `session-<uuid>`, so this filter keeps a test row from being
 * mistaken for your call. It is a good-enough discriminator, not a guarantee:
 * check the timestamp against when you actually placed the call.
 */
import { createRequire } from "node:module"

process.loadEnvFile("apps/workspace/.env.local")

const { Client } = createRequire(
  new URL("../apps/workspace/package.json", import.meta.url)
)("pg")

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const { rows } = await client.query(
  `select c.id, c.state, c.ended_reason, c.duration_secs,
          c.pipecat_session_id, a.id as attempt_id, a.ready_at,
          a.stop_reason, a.resource_state, a.dispatched_at
     from calls c
     join sandbox_attempts a on a.call_id = c.id
    where a.dispatched_at is not null
      and c.pipecat_session_id ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
    order by a.dispatched_at desc
    limit 1`
)

if (rows.length === 0) {
  console.log("No real Sandbox call on this database yet.")
} else {
  const call = rows[0]
  console.log(JSON.stringify(call, null, 2))
  const events = await client.query(
    `select seq, at, type, payload
       from call_events
      where call_id = $1
      order by seq`,
    [call.id]
  )
  console.log("\nTranscript and tool events:")
  for (const event of events.rows) {
    console.log(
      `${String(event.seq).padStart(3)}  ${event.at.toISOString().slice(11, 19)}  ${event.type}  ${JSON.stringify(event.payload)}`
    )
  }
}

await client.end()
