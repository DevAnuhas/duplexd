"use client"

import {
  Microphone,
  MicrophoneSlash,
  PhoneDisconnect,
  X,
} from "@phosphor-icons/react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { LiveSandboxTimeline } from "@/components/sandbox/timeline"
import { SandboxController, sandboxReleased } from "@/sandbox/client/controller"
import { SANDBOX_LIMITS } from "@/sandbox/protocol"

const PracticeSessionContext = createContext<{
  controller: SandboxController
  rememberName: (id: string, name: string) => void
  names: Record<string, string>
} | null>(null)

export function useOptionalPracticeSession() {
  return useContext(PracticeSessionContext)
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function connectionLabel(phase: string) {
  switch (phase) {
    case "checking":
      return "Checking audio"
    case "starting":
      return "Calling assistant"
    case "joining":
      return "Connecting audio"
    case "waiting":
      return "Waiting for assistant"
    case "ready":
      return "Connected"
    case "reconnecting":
      return "Reconnecting"
    case "finishing":
      return "Ending call…"
    default:
      return "Call status pending"
  }
}

export function PracticeSessionProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [controller] = useState(() => new SandboxController())
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  const [names, setNames] = useState<Record<string, string>>({})
  const rememberName = useCallback((id: string, label: string) => {
    setNames((current) =>
      current[id] === label ? current : { ...current, [id]: label }
    )
  }, [])
  const [expanded, setExpanded] = useState(false)
  const [hiddenNotice, setHiddenNotice] = useState(false)
  const wasShowing = useRef(false)
  const closePanel = useRef<HTMLButtonElement>(null)
  const [now, setNow] = useState(() => performance.now())
  const hasMedia = state.mediaPhase !== "off"
  const attempt = state.attempt
  const showBar =
    hasMedia ||
    (attempt !== null &&
      !sandboxReleased(attempt) &&
      attempt.resourceState !== "not_dispatched")
  const name = attempt?.assistantId
    ? (names[attempt.assistantId] ?? "Assistant")
    : "Assistant"
  // The server's execution deadline is fixed at dispatch plus the call cap.
  // This counts dispatch time too, so it can run slightly ahead of joined audio.
  const elapsed =
    state.deadlines.execution > 0
      ? formatElapsed(
          now - (state.deadlines.execution - SANDBOX_LIMITS.executionMs)
        )
      : "—"
  const nearLimit =
    state.deadlines.execution > 0 && state.deadlines.execution - now <= 60_000

  useEffect(() => {
    void controller.refresh()
    const refresh = () => {
      if (controller.getSnapshot().mediaPhase === "off")
        void controller.refresh()
      else controller.visibleAgain()
    }
    const visibility = () => {
      if (document.hidden) {
        if (
          controller.getSnapshot().mediaPhase !== "off" &&
          !controller.hidden()
        )
          setHiddenNotice(true)
      } else controller.visibleAgain()
    }
    const leaving = () => controller.leave()
    window.addEventListener("focus", refresh)
    window.addEventListener("pagehide", leaving)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener("pagehide", leaving)
      document.removeEventListener("visibilitychange", visibility)
      controller.leave()
    }
  }, [controller])

  useEffect(() => {
    const interval = setInterval(
      () => {
        if (!document.hidden) void controller.refresh()
      },
      showBar ? 5_000 : 30_000
    )
    return () => clearInterval(interval)
  }, [controller, showBar])

  useEffect(() => {
    if (!showBar) return
    setNow(performance.now())
    const interval = setInterval(() => setNow(performance.now()), 1_000)
    return () => clearInterval(interval)
  }, [showBar])

  useEffect(() => {
    if (showBar && !wasShowing.current) {
      setExpanded(true)
      setHiddenNotice(false)
    }
    wasShowing.current = showBar
  }, [showBar])

  useEffect(() => {
    if (!expanded) return
    closePanel.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false)
    }
    window.addEventListener("keydown", escape)
    return () => window.removeEventListener("keydown", escape)
  }, [expanded])

  const value = useMemo(
    () => ({ controller, rememberName, names }),
    [controller, rememberName, names]
  )

  return (
    <PracticeSessionContext.Provider value={value}>
      {children}
      {hiddenNotice && !showBar && (
        <div
          role="alert"
          className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-2xl items-center gap-3 rounded-xl border border-amber-500/50 bg-background p-4 shadow-xl sm:inset-x-6"
        >
          <p className="flex-1 text-sm">
            Practice stopped before the call connected because this tab was
            hidden. Start a new call when you are ready.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setHiddenNotice(false)}
          >
            Dismiss
          </Button>
        </div>
      )}
      {showBar && (
        <div
          className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-lg items-center gap-2 rounded-lg border bg-background p-2 shadow-lg sm:inset-x-6"
          role="region"
          aria-label="Active practice call"
        >
          <Avatar className="size-8" aria-hidden="true">
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {name.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <button
            type="button"
            className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setExpanded(true)}
            aria-label="Open practice call"
          >
            <span className="block truncate text-sm font-semibold">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              Practice · sample data ·{" "}
              {state.message?.startsWith("Confirming the call")
                ? state.message
                : connectionLabel(state.mediaPhase)}
            </span>
          </button>
          <span
            className="hidden text-sm tabular-nums sm:inline"
            aria-label={`Elapsed ${elapsed}`}
          >
            {elapsed}
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-8"
            onClick={() => {
              void controller.end()
            }}
          >
            End
          </Button>
        </div>
      )}
      {expanded && showBar && (
        <aside
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-xl sm:w-[360px]"
          aria-label="Practice call panel"
        >
          <header className="shrink-0 border-b p-3">
            <div className="flex items-center justify-between gap-2">
              <Avatar className="size-8" aria-hidden="true">
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold">{name}</h2>
                <p className="text-xs text-muted-foreground">
                  <span role="status">
                    {state.message?.startsWith("Confirming the call")
                      ? state.message
                      : connectionLabel(state.mediaPhase)}
                  </span>
                  <span aria-hidden="true"> · {elapsed}</span>
                  <span> · Practice sample data</span>
                </p>
                {hiddenNotice && state.message && (
                  <p role="status" className="mt-1 text-xs">
                    {state.message}
                  </p>
                )}
              </div>
              <Button
                ref={closePanel}
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setExpanded(false)}
                aria-label="Collapse call panel"
              >
                <X className="size-4" />
              </Button>
            </div>
            {nearLimit && (
              <p
                role="status"
                className="mt-2 text-xs text-amber-600 dark:text-amber-400"
              >
                Call ends after 10 minutes.
              </p>
            )}
            {state.outputSilent && (
              <p className="mt-2 text-xs">
                You may not be able to hear the assistant. Check your output
                device and volume.
              </p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-8 flex-1"
                disabled={!state.ownsController || state.mediaPhase !== "ready"}
                aria-pressed={state.muted}
                onClick={() => controller.mute()}
              >
                {state.muted ? (
                  <MicrophoneSlash className="size-4" aria-hidden="true" />
                ) : (
                  <Microphone className="size-4" aria-hidden="true" />
                )}
                {state.muted ? "Unmute" : "Mute"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="h-8 flex-1"
                onClick={() => {
                  void controller.end()
                }}
              >
                <PhoneDisconnect className="size-4" aria-hidden="true" /> End
                call
              </Button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {attempt ? (
              <LiveSandboxTimeline
                key={attempt.callId}
                callId={attempt.callId}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Connecting to your call…
              </p>
            )}
          </div>
        </aside>
      )}
    </PracticeSessionContext.Provider>
  )
}
