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

const connectionStages = [
  {
    phase: "checking",
    current: "Checking microphone",
    done: "Microphone ready",
  },
  {
    phase: "starting",
    current: "Starting assistant",
    done: "Assistant started",
  },
  { phase: "joining", current: "Connecting audio", done: "Audio connected" },
  {
    phase: "waiting",
    current: "Waiting for assistant",
    done: "Assistant ready",
  },
] as const

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
  const stageIndex = connectionStages.findIndex(
    (stage) => stage.phase === state.mediaPhase
  )

  useEffect(() => {
    void controller.refresh()
    const refresh = () => {
      void controller.refresh()
    }
    const hidden = () => {
      if (document.hidden) {
        if (controller.getSnapshot().mediaPhase !== "off") setHiddenNotice(true)
        controller.leave(
          "Practice stopped because this tab was hidden. Checking cleanup."
        )
      }
    }
    const leaving = () => controller.leave()
    window.addEventListener("focus", refresh)
    window.addEventListener("pagehide", leaving)
    document.addEventListener("visibilitychange", hidden)
    return () => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener("pagehide", leaving)
      document.removeEventListener("visibilitychange", hidden)
      controller.leave()
    }
  }, [controller])

  useEffect(() => {
    const interval = setInterval(
      () => {
        void controller.refresh()
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
            Practice stopped because this tab was hidden. Keep it visible while
            calling.
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
          className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-2xl items-center gap-3 rounded-xl border border-primary/40 bg-background p-3 shadow-xl sm:inset-x-6"
          role="region"
          aria-label="Active practice call"
        >
          <Avatar size="lg" aria-hidden="true">
            <AvatarFallback className="bg-primary/10 font-semibold text-primary">
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
              {hiddenNotice && state.message
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
            className="min-h-10"
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
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-2xl sm:w-[390px]"
          aria-label="Practice call panel"
        >
          <header className="shrink-0 border-b p-5">
            <div className="flex items-start justify-between gap-3">
              <Avatar size="lg" className="mt-1 size-12" aria-hidden="true">
                <AvatarFallback className="bg-primary/10 text-lg font-semibold text-primary">
                  {name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium tracking-wide text-primary uppercase">
                  Practice · sample data
                </p>
                <h2 className="mt-1 truncate text-xl font-semibold">{name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  <span role="status">{connectionLabel(state.mediaPhase)}</span>
                  <span aria-hidden="true"> · {elapsed}</span>
                </p>
                {hiddenNotice && state.message && (
                  <p role="status" className="mt-2 text-sm">
                    {state.message}
                  </p>
                )}
              </div>
              <Button
                ref={closePanel}
                type="button"
                variant="ghost"
                size="icon"
                className="size-10"
                onClick={() => setExpanded(false)}
                aria-label="Collapse call panel"
              >
                <X className="size-5" />
              </Button>
            </div>
            {nearLimit && (
              <p
                role="status"
                className="mt-3 text-sm text-amber-600 dark:text-amber-400"
              >
                Call ends after 10 minutes.
              </p>
            )}
            {state.outputSilent && (
              <p className="mt-3 text-sm">
                You may not be able to hear the assistant. Check your output
                device and volume.
              </p>
            )}
            {stageIndex >= 0 && (
              <ol
                className="mt-5 grid grid-cols-2 gap-2"
                aria-label="Connection progress"
              >
                {connectionStages.map((stage, index) => (
                  <li
                    key={stage.phase}
                    aria-current={index === stageIndex ? "step" : undefined}
                    className={`rounded-md border px-3 py-2 text-xs ${index === stageIndex ? "border-primary/50 bg-primary/10 font-semibold" : index < stageIndex ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    <span className="mr-2" aria-hidden="true">
                      {index < stageIndex
                        ? "✓"
                        : index === stageIndex
                          ? "●"
                          : "○"}
                    </span>
                    {index < stageIndex ? stage.done : stage.current}
                  </li>
                ))}
              </ol>
            )}
            <div className="mt-5 flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1"
                disabled={!state.ownsController || state.mediaPhase !== "ready"}
                aria-pressed={state.muted}
                onClick={() => controller.mute()}
              >
                {state.muted ? (
                  <MicrophoneSlash className="size-5" aria-hidden="true" />
                ) : (
                  <Microphone className="size-5" aria-hidden="true" />
                )}
                {state.muted ? "Unmute" : "Mute"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 flex-1"
                onClick={() => {
                  void controller.end()
                }}
              >
                <PhoneDisconnect className="size-5" aria-hidden="true" /> End
                call
              </Button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-4">
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
