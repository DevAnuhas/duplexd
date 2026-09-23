"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import type { AssistantFormInput } from "@/lib/assistant-schema"
import { useOptionalPracticeSession } from "@/components/sandbox/practice-session"
import {
  AssistantDraftStore,
  draftDirty,
  readPreview,
  readSampleDrafts,
  type DraftSeed,
} from "@/sandbox/client/draft-store"
import { SandboxController, sandboxReleased } from "@/sandbox/client/controller"
import { validateAssistantDraft } from "../draft-actions"

type EditorDraftFields = Pick<
  AssistantFormInput,
  "name" | "serverUrl" | "serverSecret" | "clearServerSecret"
>
type LeavingTarget = { href: string; entryKey?: string }

const DraftContext = createContext<{
  store: AssistantDraftStore
  controller: SandboxController
  assistantId: string
  getEditorDraft: () => EditorDraftFields | null
  setEditorDraft: (input: AssistantFormInput) => void
  clearEditorDraft: () => void
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
  const anotherAssistantOwnsAttempt =
    attempt.attempt !== null &&
    attempt.attempt.assistantId !== context.assistantId
  const locked =
    state.saving ||
    (!anotherAssistantOwnsAttempt &&
      (!attempt.statusKnown ||
        ["loading", "preparing", "canceling", "unknown"].includes(
          attempt.phase
        ) ||
        attempt.canRetryPreparation ||
        (attempt.attempt !== null && !sandboxReleased(attempt.attempt))))
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
  const editorDraft = useRef<EditorDraftFields | null>(null)
  const getEditorDraft = useCallback(() => editorDraft.current, [])
  const setEditorDraft = useCallback((input: AssistantFormInput) => {
    // A newly typed secret is deliberately not carried into another route.
    editorDraft.current = {
      name: input.name,
      serverUrl: input.serverUrl,
      serverSecret: "",
      clearServerSecret: false,
    }
  }, [])
  const clearEditorDraft = useCallback(() => {
    editorDraft.current = null
  }, [])
  const session = useOptionalPracticeSession()
  const router = useRouter()
  const [leavingTarget, setLeavingTarget] = useState<LeavingTarget | null>(null)
  const [localController] = useState(() => new SandboxController())
  const controller = session?.controller ?? localController
  useEffect(() => {
    store.observe(seed)
  }, [store, seed])
  useEffect(() => {
    if (session !== null) return
    void controller.refresh()
    const refresh = () => {
      if (controller.getSnapshot().mediaPhase === "off")
        void controller.refresh()
      else controller.visibleAgain()
    }
    const interval = setInterval(() => {
      if (!document.hidden) void controller.refresh()
    }, 5_000)
    window.addEventListener("focus", refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener("focus", refresh)
      controller.leave()
    }
  }, [controller, session])
  useEffect(() => {
    const assistantPath = `/assistants/${encodeURIComponent(seed.assistantId)}`
    const outsideAssistant = (destination: URL) =>
      destination.origin === window.location.origin &&
      destination.pathname !== assistantPath &&
      !destination.pathname.startsWith(`${assistantPath}/`)
    const leavingAssistant = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return
      const link = event.target.closest<HTMLAnchorElement>("a[href]")
      if (!link || link.target || link.hasAttribute("download")) return
      const destination = new URL(link.href, window.location.href)
      if (!outsideAssistant(destination) || !draftDirty(store.getSnapshot()))
        return
      event.preventDefault()
      event.stopPropagation()
      setLeavingTarget({
        href: `${destination.pathname}${destination.search}${destination.hash}`,
      })
    }
    const onTraverse = (event: NavigateEvent) => {
      if (event.navigationType !== "traverse" || !event.cancelable) return
      const destination = new URL(event.destination.url)
      if (!outsideAssistant(destination) || !draftDirty(store.getSnapshot()))
        return
      event.preventDefault()
      setLeavingTarget({
        href: `${destination.pathname}${destination.search}${destination.hash}`,
        entryKey: event.destination.key,
      })
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftDirty(store.getSnapshot())) return
      event.preventDefault()
      event.returnValue = ""
    }
    document.addEventListener("click", leavingAssistant, true)
    window.navigation?.addEventListener("navigate", onTraverse)
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      document.removeEventListener("click", leavingAssistant, true)
      window.navigation?.removeEventListener("navigate", onTraverse)
      window.removeEventListener("beforeunload", beforeUnload)
    }
  }, [seed.assistantId, store])
  return (
    <DraftContext.Provider
      value={{
        store,
        controller,
        assistantId: seed.assistantId,
        getEditorDraft,
        setEditorDraft,
        clearEditorDraft,
      }}
    >
      <DraftStatus />
      {children}
      <AlertDialog
        open={leavingTarget !== null}
        onOpenChange={(open) => {
          if (!open) setLeavingTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave with unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your assistant and sample edits will be discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (leavingTarget === null) return
                clearEditorDraft()
                store.discard()
                if (
                  leavingTarget.entryKey !== undefined &&
                  typeof window.navigation?.traverseTo === "function"
                )
                  void window.navigation.traverseTo(leavingTarget.entryKey)
                else router.push(leavingTarget.href)
                setLeavingTarget(null)
              }}
            >
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DraftContext.Provider>
  )
}

function DraftStatus() {
  const { store, state, controller, attempt, locked, clearEditorDraft } =
    useAssistantDraft()
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
  if (!conflict && (!locked || attempt.mediaPhase !== "off")) return null
  return (
    <section
      aria-label="Draft status"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
    >
      <p role="status">
        {conflict
          ? "A newer version was saved elsewhere. Your edits are still here."
          : "Checking the current call before editing."}
      </p>
      <div className="flex flex-wrap gap-1">
        {locked && !conflict && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void controller.refresh()}
          >
            Refresh
          </Button>
        )}
        {conflict && !locked && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => router.refresh()}
            >
              Fetch latest
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={state.latest === null || !store.canResolveConflict()}
              onClick={() => store.rebase()}
            >
              Keep my edits
            </Button>
          </>
        )}
        {!locked && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!store.canResolveConflict()}
              >
                Discard edits
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Discard unsaved edits?</AlertDialogTitle>
                <AlertDialogDescription>
                  This restores the last saved assistant and sample responses.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep editing</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    clearEditorDraft()
                    store.discard()
                  }}
                >
                  Discard
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </section>
  )
}
