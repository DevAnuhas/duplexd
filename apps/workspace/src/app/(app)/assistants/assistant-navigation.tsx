import Link from "next/link"

const tabs = [
  { id: "configure", label: "Assistant", suffix: "" },
  { id: "practice", label: "Talk", suffix: "/sandbox" },
  { id: "calls", label: "Calls", suffix: "/calls" },
] as const

export function AssistantNavigation({
  assistantId,
  active,
}: {
  assistantId: string
  active: "configure" | "practice" | "calls"
}) {
  return (
    <nav aria-label="Assistant navigation" className="flex gap-1 border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={`/assistants/${encodeURIComponent(assistantId)}${tab.suffix}`}
          aria-current={active === tab.id ? "page" : undefined}
          className={`flex h-9 items-center border-b-2 px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring ${active === tab.id ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
