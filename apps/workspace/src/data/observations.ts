import { randomUUID } from "node:crypto"

import { and, asc, eq, sql } from "drizzle-orm"

import { getDb } from "@/db/client"
import { callObservations, calls, users } from "@/db/schema"

// A JSON client may escape each astral code point as two \uXXXX sequences.
export const OBSERVATION_BODY_LIMIT = 26_000
export const CHECKLIST_VERSION = 1
export const OBSERVATION_ANSWERS = ["met", "needs_work", "not_checked"] as const
export type ObservationAnswer = (typeof OBSERVATION_ANSWERS)[number]

export type ObservationInput = {
  expectedRevision: number
  heardExpectedAnswer: ObservationAnswer
  correctToolOutcome: ObservationAnswer
  honestFailureSpeech: ObservationAnswer
  acceptableInterruptionWaiting: ObservationAnswer
  note: string
}

export type Observation = {
  id: string
  revision: number
  checklistVersion: number
  heardExpectedAnswer: ObservationAnswer
  correctToolOutcome: ObservationAnswer
  honestFailureSpeech: ObservationAnswer
  acceptableInterruptionWaiting: ObservationAnswer
  note: string
  authorName: string
  isMine: boolean
  createdAt: Date
  updatedAt: Date
}

const answerSet = new Set<string>(OBSERVATION_ANSWERS)
function isBidiControl(point: number): boolean {
  return (
    point === 0x61c ||
    point === 0x200e ||
    point === 0x200f ||
    (point >= 0x202a && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x206f)
  )
}

function hasUnsafeNoteCharacter(note: string): boolean {
  for (const character of note) {
    const point = character.codePointAt(0)!
    if (
      (point < 32 && point !== 9 && point !== 10) ||
      (point >= 0x7f && point <= 0x9f) ||
      isBidiControl(point)
    )
      return true
  }
  return false
}

function safeAuthorName(
  name: string | null,
  authorUserId: string | null
): string {
  if (authorUserId === null) return "Former member"
  const display = name?.normalize("NFC").trim()
  if (!display || [...display].length > 80 || display.includes("@"))
    return "Member"
  for (const character of display) {
    const point = character.codePointAt(0)!
    if (
      point < 32 ||
      (point >= 0x7f && point <= 0x9f) ||
      isBidiControl(point)
    ) {
      return "Member"
    }
  }
  return display
}

export function parseObservationInput(value: unknown): ObservationInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const keys = [
    "heardExpectedAnswer",
    "correctToolOutcome",
    "honestFailureSpeech",
    "acceptableInterruptionWaiting",
  ] as const
  const allowed = new Set<string>(["expectedRevision", "note", ...keys])
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 0 ||
    keys.some((key) => !answerSet.has(input[key] as string)) ||
    typeof input.note !== "string"
  ) {
    return null
  }
  const note = input.note.normalize("NFC")
  if ([...note].length > 2_000 || hasUnsafeNoteCharacter(note)) return null
  return {
    expectedRevision: input.expectedRevision as number,
    heardExpectedAnswer: input.heardExpectedAnswer as ObservationAnswer,
    correctToolOutcome: input.correctToolOutcome as ObservationAnswer,
    honestFailureSpeech: input.honestFailureSpeech as ObservationAnswer,
    acceptableInterruptionWaiting:
      input.acceptableInterruptionWaiting as ObservationAnswer,
    note,
  }
}

const projection = {
  id: callObservations.id,
  revision: callObservations.revision,
  checklistVersion: callObservations.checklistVersion,
  heardExpectedAnswer: callObservations.heardExpectedAnswer,
  correctToolOutcome: callObservations.correctToolOutcome,
  honestFailureSpeech: callObservations.honestFailureSpeech,
  acceptableInterruptionWaiting: callObservations.acceptableInterruptionWaiting,
  note: callObservations.note,
  authorUserId: callObservations.authorUserId,
  authorName: users.name,
  createdAt: callObservations.createdAt,
  updatedAt: callObservations.updatedAt,
}

function safeObservation(
  row: {
    id: string
    revision: number
    checklistVersion: number
    heardExpectedAnswer: ObservationAnswer
    correctToolOutcome: ObservationAnswer
    honestFailureSpeech: ObservationAnswer
    acceptableInterruptionWaiting: ObservationAnswer
    note: string
    authorUserId: string | null
    authorName: string | null
    createdAt: Date
    updatedAt: Date
  },
  userId: string
): Observation {
  return {
    id: row.id,
    revision: row.revision,
    checklistVersion: row.checklistVersion,
    heardExpectedAnswer: row.heardExpectedAnswer,
    correctToolOutcome: row.correctToolOutcome,
    honestFailureSpeech: row.honestFailureSpeech,
    acceptableInterruptionWaiting: row.acceptableInterruptionWaiting,
    note: row.note,
    authorName: safeAuthorName(row.authorName, row.authorUserId),
    isMine: row.authorUserId === userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function readRows(accountId: string, userId: string, callId: string) {
  return getDb()
    .select(projection)
    .from(callObservations)
    .innerJoin(calls, eq(calls.id, callObservations.callId))
    .leftJoin(
      users,
      and(
        eq(users.id, callObservations.authorUserId),
        eq(users.accountId, calls.accountId)
      )
    )
    .where(and(eq(calls.id, callId), eq(calls.accountId, accountId)))
    .orderBy(asc(callObservations.createdAt), asc(callObservations.id))
    .then((rows) => rows.map((row) => safeObservation(row, userId)))
}

export async function getCallObservationsForAccount(
  accountId: string,
  callId: string,
  userId: string
): Promise<Observation[] | null> {
  const visible = await getDb()
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.accountId, accountId)))
    .limit(1)
  if (visible.length === 0) return null
  return readRows(accountId, userId, callId)
}

export type PutObservationResult =
  | { kind: "saved"; observation: Observation }
  | { kind: "conflict"; current: Observation }
  | { kind: "not_found" }

/** Both writes scope the call in the same SQL statement as the mutation. */
export async function putCallObservation(
  accountId: string,
  userId: string,
  callId: string,
  input: ObservationInput
): Promise<PutObservationResult> {
  const db = getDb()
  const written =
    input.expectedRevision === 0
      ? await db.execute(sql`
        INSERT INTO call_observations
          (id, call_id, author_user_id, revision, checklist_version,
           heard_expected_answer, correct_tool_outcome, honest_failure_speech,
           acceptable_interruption_waiting, note)
        SELECT ${randomUUID()}, c.id, ${userId}, 1, ${CHECKLIST_VERSION},
          ${input.heardExpectedAnswer}::observation_answer,
          ${input.correctToolOutcome}::observation_answer,
          ${input.honestFailureSpeech}::observation_answer,
          ${input.acceptableInterruptionWaiting}::observation_answer, ${input.note}
        FROM calls c
        JOIN users u ON u.id = ${userId} AND u.account_id = c.account_id
        WHERE c.id = ${callId} AND c.account_id = ${accountId}
          AND c.source = 'sandbox' AND c.state IN ('ended', 'incomplete', 'failed')
          AND c.started_at IS NOT NULL
        ON CONFLICT (call_id, author_user_id) DO NOTHING
        RETURNING id, revision, checklist_version AS "checklistVersion",
          heard_expected_answer AS "heardExpectedAnswer",
          correct_tool_outcome AS "correctToolOutcome",
          honest_failure_speech AS "honestFailureSpeech",
          acceptable_interruption_waiting AS "acceptableInterruptionWaiting",
          note, created_at AS "createdAt", updated_at AS "updatedAt"
      `)
      : await db.execute(sql`
        UPDATE call_observations o SET
          revision = o.revision + 1,
          heard_expected_answer = ${input.heardExpectedAnswer}::observation_answer,
          correct_tool_outcome = ${input.correctToolOutcome}::observation_answer,
          honest_failure_speech = ${input.honestFailureSpeech}::observation_answer,
          acceptable_interruption_waiting = ${input.acceptableInterruptionWaiting}::observation_answer,
          note = ${input.note}, updated_at = now()
        FROM calls c, users u
        WHERE o.call_id = c.id AND o.call_id = ${callId}
          AND o.author_user_id = ${userId} AND o.revision = ${input.expectedRevision}
          AND c.account_id = ${accountId} AND c.source = 'sandbox'
          AND c.state IN ('ended', 'incomplete', 'failed')
          AND c.started_at IS NOT NULL
          AND u.id = ${userId} AND u.account_id = c.account_id
        RETURNING o.id, o.revision, o.checklist_version AS "checklistVersion",
          o.heard_expected_answer AS "heardExpectedAnswer",
          o.correct_tool_outcome AS "correctToolOutcome",
          o.honest_failure_speech AS "honestFailureSpeech",
          o.acceptable_interruption_waiting AS "acceptableInterruptionWaiting",
          o.note, o.created_at AS "createdAt", o.updated_at AS "updatedAt"
      `)

  // Return the row produced by this statement, even if another author edit is
  // already queued after it. A later read is only needed to resolve conflicts.
  if (written.rows.length > 0) {
    const row = written.rows[0] as {
      id: string
      revision: number
      checklistVersion: number
      heardExpectedAnswer: ObservationAnswer
      correctToolOutcome: ObservationAnswer
      honestFailureSpeech: ObservationAnswer
      acceptableInterruptionWaiting: ObservationAnswer
      note: string
      createdAt: Date
      updatedAt: Date
    }
    const [author] = await db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
      .limit(1)
    return {
      kind: "saved",
      observation: {
        ...row,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        authorName: safeAuthorName(author?.name ?? null, userId),
        isMine: true,
      },
    }
  }
  const rows = await readRows(accountId, userId, callId)
  const mine = rows.find((row) => row.isMine)
  // A duplicate first insert or stale edit can disclose only the caller's own row.
  const eligible = await db
    .select({ id: calls.id })
    .from(calls)
    .where(
      and(
        eq(calls.id, callId),
        eq(calls.accountId, accountId),
        eq(calls.source, "sandbox"),
        sql`${calls.state} IN ('ended', 'incomplete', 'failed')`,
        sql`${calls.startedAt} IS NOT NULL`
      )
    )
    .limit(1)
  return eligible.length > 0 && mine !== undefined
    ? { kind: "conflict", current: mine }
    : { kind: "not_found" }
}
