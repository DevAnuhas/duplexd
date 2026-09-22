"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  AssistantDraftStore,
  draftDirty,
  readPreview,
  readSampleDrafts,
  type DraftSeed,
} from "@/sandbox/client/draft-store"
import { SandboxController, sandboxReleased } from "@/sandbox/client/controller"
import { validateAssistantDraft } from "../draft-actions"

const DraftContext = createContext<{
  store: AssistantDraftStore
  controller: SandboxController
} | null>(null)

export function useAssistantDraft() {
  const context = useContext(DraftContext)
  if (context === null) throw new Error("Assistant draft host is missing.")
  const state = useSyncExternalStore(
    context.store.subscribe,
    context.store.getSnapshot,
    context.store.getSnapshot
  )
  const attempt = useSyncExternalStore(
    context.controller.subscribe,
    context.controller.getSnapshot,
    context.controller.getSnapshot
  )
  const locked =
    state.saving ||
    !attempt.statusKnown ||
    ["loading", "preparing", "canceling", "unknown"].includes(attempt.phase) ||
    attempt.canRetryPreparation ||
    (attempt.attempt !== null && !sandboxReleased(attempt.attempt))
  return { ...context, state, attempt, locked }
}
export function useOptionalAssistantDraft() {
  return useContext(DraftContext)
}

export function AssistantDraftProvider({
  seed,
  children,
}: {
  seed: DraftSeed
  children: React.ReactNode
}) {
  const [store] = useState(() => new AssistantDraftStore(seed))
  const [controller] = useState(() => new SandboxController())
  useEffect(() => {
    store.observe(seed)
  }, [store, seed])
  useEffect(() => {
    void controller.refresh()
    const refresh = () => {
      void controller.refresh()
    }
    const interval = setInterval(refresh, 5_000)
    window.addEventListener("focus", refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener("focus", refresh)
      controller.leave()
    }
  }, [controller])
  useEffect(() => {
    const base = `/assistants/${encodeURIComponent(seed.assistantId)}`
    const warn = () => {
      const state = store.getSnapshot()
      return (
        draftDirty(state) &&
        !window.confirm(
          "Discard unsaved assistant and sample changes? They are kept only in this tab."
        )
      )
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftDirty(store.getSnapshot())) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    const shouldStay = (url: URL) => {
      if (
        url.origin === window.location.origin &&
        (url.pathname === base || url.pathname === `${base}/sandbox`)
      ) {
        return (
          url.pathname !== window.location.pathname &&
          store.getSnapshot().editorOnlyDirty &&
          !window.confirm(
            "Unsaved name or connection fields cannot move to Sandbox and will be discarded. Your conversation draft is kept. Continue?"
          )
        )
      }
      return warn()
    }
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      const anchor =
        event.target instanceof Element ? event.target.closest("a[href]") : null
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return
      const url = new URL(anchor.href, window.location.href)
      if (shouldStay(url)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    // App Router Back/Forward is same-document navigation: beforeunload does
    // not run. Modern browsers expose a cancelable traversal here.
    const onTraverse = (event: NavigateEvent) => {
      if (
        event.navigationType === "traverse" &&
        event.cancelable &&
        shouldStay(new URL(event.destination.url))
      )
        event.preventDefault()
    }
    window.addEventListener("beforeunload", beforeUnload)
    document.addEventListener("click", onClick, true)
    window.navigation?.addEventListener("navigate", onTraverse)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      document.removeEventListener("click", onClick, true)
      window.navigation?.removeEventListener("navigate", onTraverse)
    }
  }, [store, seed.assistantId])
  return (
    <DraftContext.Provider value={{ store, controller }}>
      <DraftStatus />
      {children}
    </DraftContext.Provider>
  )
}

function DraftStatus() {
  const { store, state, controller, attempt, locked } = useAssistantDraft()
  const router = useRouter()
  const conflict =
    state.assistantConflict !== null || state.sampleConflict !== null
  useEffect(() => {
    if (locked) return
    const version = state.version
    const selected = state.source === "preview" ? state.fields : state.saved
    const parsed = readPreview(selected)
    const samples = readSampleDrafts(state.samples)
    if (parsed.issues.length > 0) {
      store.setValidation(version, {
        issues: [...parsed.issues, ...samples.issues],
        tools: [],
      })
      return
    }
    const timer = setTimeout(() => {
      void validateAssistantDraft({
        assistantId: state.assistantId,
        baseRevision: state.baseRevision,
        source: state.source,
        ...(state.source === "preview" ? { preview: parsed.preview } : {}),
        samples: samples.issues.length > 0 ? [] : samples.definitions,
      })
        .then((result) => {
          store.setValidation(version, {
            ...result,
            issues: [...samples.issues, ...result.issues],
          })
          if (
            result.currentRevision !== undefined &&
            store.getSnapshot().version === version
          )
            store.conflict("assistant", result.currentRevision)
        })
        .catch(() => {
          store.setValidation(version, {
            issues: [
              {
                field: "validation",
                message:
                  "Configuration checks are unavailable. Your draft is kept; refresh status or try again after signing in.",
              },
            ],
            tools: [],
          })
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [
    store,
    state.version,
    state.source,
    state.fields,
    state.saved,
    state.samples,
    state.assistantId,
    state.baseRevision,
    locked,
  ])
  useEffect(() => {
    if (attempt.conflict !== null) {
      store.conflict(attempt.conflict.kind, attempt.conflict.revision)
      router.refresh()
    }
  }, [attempt.conflict, store, router])
  if (!conflict && !locked && !draftDirty(state)) return null
  return (
    <section
      aria-label="Draft status"
      className="mb-6 space-y-3 rounded-lg border bg-muted/30 p-4"
    >
      <p role="status" className="text-sm">
        {state.saving
          ? "Saving explicit changes…"
          : locked
            ? "Editing is locked while a test is being checked, prepared or remains unresolved. Its snapshot will not change."
            : conflict
              ? "Saved configuration or samples changed. Your local draft has been kept."
              : "Unsaved conversation or sample changes are kept in this tab across Configure and Sandbox. Refreshing or leaving can discard them."}
      </p>
      <div className="flex flex-wrap gap-2">
        {locked && !state.saving && (
          <>
            <Button
              variant="outline"
              type="button"
              className="min-h-11"
              disabled={["preparing", "canceling"].includes(attempt.phase)}
              onClick={() => {
                void controller.refresh()
              }}
            >
              Refresh test status
            </Button>
            {attempt.attempt !== null && !sandboxReleased(attempt.attempt) && (
              <Button
                variant="outline"
                type="button"
                className="min-h-11"
                disabled={attempt.phase === "canceling"}
                onClick={() => {
                  void controller.cancel()
                }}
              >
                {attempt.mediaPhase === "off"
                  ? "Cancel active preparation"
                  : "End active call"}
              </Button>
            )}
          </>
        )}
        {conflict && !locked && (
          <>
            <Button
              variant="outline"
              type="button"
              className="min-h-11"
              onClick={() => router.refresh()}
            >
              Fetch latest saved version
            </Button>
            <Button
              variant="outline"
              type="button"
              className="min-h-11"
              disabled={state.latest === null || !store.canResolveConflict()}
              onClick={() => {
                if (
                  window.confirm(
                    "Rebase your local edits on the latest saved revision? Changed local fields and sample mappings are kept. This does not save them."
                  )
                )
                  store.rebase()
              }}
            >
              Rebase my draft
            </Button>
          </>
        )}
        {!locked && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={!store.canResolveConflict()}
            onClick={() => {
              if (
                window.confirm(
                  "Discard local assistant and sample changes and reload the latest fetched saved values?"
                )
              )
                store.discard()
            }}
          >
            Discard draft / reload saved
          </Button>
        )}
      </div>
      {conflict && (
        <p className="text-sm text-muted-foreground">
          Rebase keeps your edited fields; newer saved values fill untouched
          fields. Locally edited sample mappings are kept as a whole. Saving
          remains a separate action.
        </p>
      )}
    </section>
  )
}
