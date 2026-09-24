"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { Observation, ObservationAnswer } from "@/data/observations"

const items = [
  ["heardExpectedAnswer", "Heard the expected answer"],
  ["correctToolOutcome", "Observed the correct tool outcome"],
  ["honestFailureSpeech", "Failure speech was honest"],
  ["acceptableInterruptionWaiting", "Interruption and waiting felt acceptable"],
] as const
type AnswerKey = (typeof items)[number][0]
type Answers = Record<AnswerKey, ObservationAnswer>
const empty: Answers = {
  heardExpectedAnswer: "not_checked",
  correctToolOutcome: "not_checked",
  honestFailureSpeech: "not_checked",
  acceptableInterruptionWaiting: "not_checked",
}
const labels: Record<ObservationAnswer, string> = {
  met: "Met",
  needs_work: "Needs work",
  not_checked: "Not checked",
}

export function ObservationEditor({
  callId,
  initialObservations,
}: {
  callId: string
  initialObservations: Observation[]
}) {
  const [observations, setObservations] = useState(initialObservations)
  const mine = observations.find((row) => row.isMine)
  const [answers, setAnswers] = useState<Answers>(() =>
    mine
      ? (Object.fromEntries(items.map(([key]) => [key, mine[key]])) as Answers)
      : empty
  )
  const [note, setNote] = useState(mine?.note ?? "")
  const [expectedRevision, setExpectedRevision] = useState(mine?.revision ?? 0)
  const [conflict, setConflict] = useState<Observation | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const noteLength = [...note.normalize("NFC")].length

  function replaceMine(row: Observation) {
    setObservations((previous) => [
      ...previous.filter((item) => !item.isMine),
      row,
    ])
  }

  async function save() {
    if (busy || conflict || noteLength > 2_000) return
    setBusy(true)
    setMessage(null)
    try {
      const csrfResponse = await fetch("/api/workspace/sandbox/csrf", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      })
      const csrf = await csrfResponse.json()
      if (!csrfResponse.ok || typeof csrf.token !== "string")
        throw new Error("Session unavailable")
      const response = await fetch(
        `/api/workspace/calls/${encodeURIComponent(callId)}/observations`,
        {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "content-type": "application/json",
            "x-duplexd-csrf": csrf.token,
          },
          body: JSON.stringify({
            expectedRevision,
            ...answers,
            note,
          }),
        }
      )
      const result = await response.json()
      if (response.status === 409 && result.current) {
        const current = result.current as Observation
        replaceMine(current)
        setConflict(current)
        setMessage(
          "This review changed in another tab. Choose how to handle your unsaved edits."
        )
      } else if (response.ok && result.observation) {
        const saved = result.observation as Observation
        replaceMine(saved)
        setExpectedRevision(saved.revision)
        setMessage("Your observations were saved.")
      } else if (response.status === 404) {
        setMessage("This call can no longer accept observations.")
      } else {
        setMessage(
          "The observation could not be saved. Check the note and retry."
        )
      }
    } catch {
      setMessage("The observation could not be saved. Retry when connected.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Human observations"
      className="space-y-4 rounded-lg border p-4"
    >
      <div>
        <h3 className="font-semibold">Your observations</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          These are your judgments, separate from the recorded call evidence.
          Not checked is never treated as a pass.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map(([key, label]) => (
          <label key={key} className="flex flex-col gap-2 text-sm">
            <span>{label}</span>
            <select
              value={answers[key]}
              onChange={(event) =>
                setAnswers((previous) => ({
                  ...previous,
                  [key]: event.target.value as ObservationAnswer,
                }))
              }
              className="min-h-11 rounded-md border bg-background px-3"
            >
              {(Object.keys(labels) as ObservationAnswer[]).map((answer) => (
                <option key={answer} value={answer}>
                  {labels[answer]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label className="block space-y-2 text-sm">
        <span>Notes</span>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={5}
          placeholder="What would you change before testing again?"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {noteLength} / 2,000 characters
      </p>
      {noteLength > 2_000 && (
        <p role="alert" className="text-sm text-destructive">
          Shorten the note to 2,000 characters before saving.
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {conflict && (
        <div className="flex flex-wrap gap-2 rounded-md border p-3">
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setAnswers(
                Object.fromEntries(
                  items.map(([key]) => [key, conflict[key]])
                ) as Answers
              )
              setNote(conflict.note)
              setExpectedRevision(conflict.revision)
              setConflict(null)
              setMessage("Loaded the latest saved observation.")
            }}
          >
            Load latest version
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setExpectedRevision(conflict.revision)
              setConflict(null)
              setMessage("Your edits are kept. Review them, then save again.")
            }}
          >
            Keep my edits
          </Button>
        </div>
      )}
      <Button
        disabled={busy || conflict !== null || noteLength > 2_000}
        onClick={() => void save()}
        className="min-h-11"
      >
        {busy ? "Saving…" : "Save observations"}
      </Button>
      {observations.filter((row) => !row.isMine).length > 0 && (
        <div className="space-y-3 border-t pt-4">
          <h4 className="text-sm font-semibold">Other members’ observations</h4>
          {observations
            .filter((row) => !row.isMine)
            .map((row) => (
              <div key={row.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">{row.authorName}</p>
                <ul className="mt-2 space-y-1">
                  {items.map(([key, label]) => (
                    <li key={key}>
                      {label}: {labels[row[key]]}
                    </li>
                  ))}
                </ul>
                {row.note && (
                  <p className="mt-2 [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {row.note}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}
    </section>
  )
}
