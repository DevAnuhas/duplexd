import "./helpers/assistant-form/dom-environment.ts"

import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ validate: vi.fn(), refresh: vi.fn() }))
const router = { refresh: mocks.refresh, replace: vi.fn() }
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/app/(app)/assistants/draft-actions", () => ({
  validateAssistantDraft: mocks.validate,
}))

import {
  AssistantForm,
  type AssistantFormValues,
} from "@/app/(app)/assistants/assistant-form"
import {
  AssistantDraftProvider,
  useAssistantDraft,
} from "@/app/(app)/assistants/[id]/draft-host"
import { Sandbox } from "@/app/(app)/assistants/[id]/sandbox/sandbox"
import { rileyPracticeTemplate } from "@/practice/riley"
import {
  compilePracticeConfiguration,
  fingerprintToolInputSchema,
  projectAssistantTools,
} from "@/practice/configuration"
import { parsePracticeSampleDefinitions } from "@/practice/samples"
import {
  previewFields,
  type DraftSeed,
  type AssistantDraftStore,
} from "@/sandbox/client/draft-store"
import { click, type as typeInto } from "./helpers/assistant-form/render.ts"

const template = rileyPracticeTemplate()
const initial: DraftSeed = {
  assistantId: "assistant-a",
  revision: 3,
  fields: previewFields({
    ...template.assistant,
    serverUrl: "",
    tools: JSON.stringify(template.assistant.tools, null, 2),
  }),
  sampleRevision: 2,
  definitions: template.samples,
}
let root: Root | undefined
let container: HTMLDivElement
let store: AssistantDraftStore
let currentSeed: DraftSeed
let currentEditorValues: Pick<AssistantFormValues, "name" | "serverUrl">
const saveAssistant = vi.fn<
  (data: FormData) => Promise<{ ok: true; revision: number }>
>(async () => ({ ok: true, revision: 4 }))
let requests: Array<{ path: string; options?: RequestInit }>
let sampleReply: () => Response
function Fixture() {
  const [screen, setScreen] = useState("configure")
  store = useAssistantDraft().store
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        onClick: () =>
          setScreen(screen === "configure" ? "sandbox" : "configure"),
      },
      "Switch screen"
    ),
    screen === "configure"
      ? createElement(AssistantForm, {
          values: {
            ...template.assistant,
            ...currentEditorValues,
            hasServerSecret: true,
            id: "assistant-a",
            revision: currentSeed.revision,
            instructions: currentSeed.fields.instructions,
          },
          action: saveAssistant,
          submitLabel: "Save changes",
        })
      : createElement(Sandbox, {
          assistant: {
            id: "assistant-a",
            name: "Riley",
            revision: 3,
            voice: "marin",
            backendModel: "gpt-5.6-luna",
          },
        })
  )
}
async function render(
  seed = initial,
  editorValues: Pick<AssistantFormValues, "name" | "serverUrl"> = {
    name: template.assistant.name,
    serverUrl: template.assistant.serverUrl,
  }
) {
  currentSeed = seed
  currentEditorValues = editorValues
  await act(async () => {
    root!.render(
      createElement(AssistantDraftProvider, {
        seed,
        children: createElement(Fixture),
      })
    )
  })
}
async function validated() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label
  )
  if (found === undefined) throw new Error(`Missing button ${label}`)
  return found
}
function field(selector: string) {
  const found = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector
  )
  if (found === null) throw new Error(`Missing field ${selector}`)
  return found
}
beforeEach(async () => {
  requests = []
  Object.defineProperty(window, "navigation", {
    configurable: true,
    value: new EventTarget(),
  })
  vi.clearAllMocks()
  vi.spyOn(window, "confirm").mockReturnValue(true)
  sampleReply = () =>
    Response.json({
      revision: 3,
      definitions: JSON.parse(String(requests.at(-1)?.options?.body))
        .definitions,
    })
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (path, options) => {
      requests.push({ path: String(path), options })
      if (String(path).endsWith("/csrf"))
        return Response.json({ token: "csrf" })
      if (options?.method === "PUT") return sampleReply()
      if (options?.method === "POST")
        return Response.json({
          attempt: {
            attemptId: "attempt-a",
            callId: "call-a",
            assistantId: "assistant-a",
            state: String(path).endsWith("/stop") ? "canceled" : "prepared",
            callState: "reserved",
            source: "sandbox",
            testMode: "practice",
            reservationExpiresAt: "2026-09-22T09:00:30Z",
            execution: "disabled",
          },
        })
      return Response.json({ attempt: null })
    })
  )
  mocks.validate.mockImplementation(async (input) => {
    const assistant = {
      ...template.assistant,
      id: "assistant-a",
      revision: input.baseRevision,
    }
    const tools =
      input.source === "preview" ? input.preview.tools : assistant.tools
    const parsed = parsePracticeSampleDefinitions(input.samples, tools)
    const compiled = compilePracticeConfiguration({
      ...input,
      assistant,
      samples: parsed.ok ? parsed.definitions : [],
      sampleRevision: 2,
    })
    return {
      tools: (projectAssistantTools(tools) ?? []).map((tool) => ({
        name: tool.name,
        fingerprint: fingerprintToolInputSchema(tool),
        parameters: tool.parameters,
      })),
      issues: [
        ...(parsed.ok ? [] : parsed.issues),
        ...(compiled.kind === "invalid" ? compiled.issues : []),
      ],
    }
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await render()
  await validated()
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("shared Configure and Sandbox drafts", () => {
  it("preserves unsaved conversation edits across navigation and prepares without saving or including connection fields", async () => {
    await typeInto(field('[name="instructions"]'), "Local preview instructions")
    await typeInto(
      field('[name="serverSecret"]'),
      "synthetic-secret-must-not-cross"
    )
    await typeInto(
      field('[name="serverUrl"]'),
      "https://synthetic.invalid/private"
    )
    expect(
      container.querySelector('a[href="/assistants/assistant-a/sandbox"]')
    ).not.toBeNull()
    await click(button("Switch screen"))
    await validated()
    expect(
      container.querySelector<HTMLInputElement>('input[value="preview"]')!
        .checked
    ).toBe(true)
    await click(button("Prepare without calling"))
    const body = JSON.parse(
      String(
        requests.find(
          (request) =>
            request.path.endsWith("/attempts") &&
            request.options?.method === "POST"
        )?.options?.body
      )
    )
    expect(body).toMatchObject({
      source: "preview",
      baseRevision: 3,
      preview: { instructions: "Local preview instructions" },
      sampleRevision: 2,
    })
    expect(Object.keys(body.preview).sort()).toEqual(
      [
        "accentStyle",
        "backendInstructions",
        "backendModel",
        "instructions",
        "tools",
        "voice",
        "waitingBehavior",
      ].sort()
    )
    expect(JSON.stringify(body)).not.toContain("synthetic-secret")
    expect(JSON.stringify(body)).not.toContain("synthetic.invalid")
    expect(saveAssistant).not.toHaveBeenCalled()
    expect(requests.some((request) => request.options?.method === "PUT")).toBe(
      false
    )
    await click(button("Switch screen"))
    expect(field('[name="instructions"]').value).toBe(
      "Local preview instructions"
    )
    expect(field('[name="serverSecret"]').value).toBe("")
    expect(
      container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled
    ).toBe(true)
  })
  it.each(["discard", "rebase then save"] as const)(
    "preserves editor-local changes through remote prop refresh until explicit %s",
    async (resolution) => {
      const local = {
        name: "Local unsaved name",
        url: "https://local.example.test/voice",
        secret: "synthetic-local-credential",
      }
      await typeInto(field('[name="name"]'), local.name)
      await typeInto(field('[name="serverUrl"]'), local.url)
      await typeInto(field('[name="serverSecret"]'), local.secret)
      const removal = () =>
        container.querySelector<HTMLButtonElement>('[role="checkbox"]')!
      await click(removal())
      expect(removal().getAttribute("aria-checked")).toBe("true")
      expect(store.getSnapshot().editorOnlyDirty).toBe(true)
      const newer = { ...initial, revision: 4 }
      const remote = {
        name: "Remote saved name",
        serverUrl: "https://remote.example.test/voice",
      }
      await render(newer, remote)
      expect(store.getSnapshot().assistantConflict).toBe(4)
      expect(field('[name="name"]').value).toBe(local.name)
      expect(field('[name="serverUrl"]').value).toBe(local.url)
      expect(field('[name="serverSecret"]').value).toBe(local.secret)
      expect(removal().getAttribute("aria-checked")).toBe("true")
      expect(store.getSnapshot().editorOnlyDirty).toBe(true)
      expect(JSON.stringify(store.getSnapshot())).not.toContain(local.secret)
      expect(JSON.stringify(store.getSnapshot())).not.toContain(local.url)
      expect(JSON.stringify(store.getSnapshot())).not.toContain(local.name)
      expect(saveAssistant).not.toHaveBeenCalled()
      expect(window.confirm).not.toHaveBeenCalled()
      if (resolution === "discard") {
        await click(button("Discard draft / reload saved"))
        expect(field('[name="name"]').value).toBe(remote.name)
        expect(field('[name="serverUrl"]').value).toBe(remote.serverUrl)
      } else {
        await click(button("Rebase my draft"))
        expect(field('[name="name"]').value).toBe(local.name)
        expect(field('[name="serverUrl"]').value).toBe(local.url)
        expect(field('[name="serverSecret"]').value).toBe(local.secret)
        expect(removal().getAttribute("aria-checked")).toBe("true")
        // A replacement credential and a removal are alternatives. Choose the
        // replacement explicitly before submitting a valid save.
        await click(removal())
        await act(async () => {
          container
            .querySelector("form")!
            .dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true })
            )
        })
        expect(saveAssistant).toHaveBeenCalledOnce()
        const submitted = saveAssistant.mock.calls[0]![0]
        expect(submitted.get("expectedRevision")).toBe("4")
        expect(submitted.get("name")).toBe(local.name)
        expect(submitted.get("serverUrl")).toBe(local.url)
        expect(submitted.get("serverSecret")).toBe(local.secret)
        expect(submitted.has("clearServerSecret")).toBe(false)
        expect(field('[name="name"]').value).toBe(local.name)
        expect(field('[name="serverUrl"]').value).toBe(local.url)
      }
      expect(field('[name="serverSecret"]').value).toBe("")
      expect(removal().getAttribute("aria-checked")).toBe("false")
      expect(store.getSnapshot().editorOnlyDirty).toBe(false)
    }
  )

  it("keeps conflicts and edited fields through both screens until explicit rebase", async () => {
    await typeInto(field('[name="instructions"]'), "Local draft survives")
    const newer = {
      ...initial,
      revision: 4,
      fields: {
        ...initial.fields,
        instructions: "Remote edit",
        accentStyle: "Remote style",
      },
    }
    await render(newer)
    expect(field('[name="instructions"]').value).toBe("Local draft survives")
    expect(store.getSnapshot().baseRevision).toBe(3)
    await click(button("Switch screen"))
    expect(container.textContent).toContain("Your local draft has been kept")
    expect(button("Prepare without calling").disabled).toBe(true)
    await click(button("Rebase my draft"))
    expect(store.getSnapshot().baseRevision).toBe(4)
    await click(button("Switch screen"))
    expect(field('[name="instructions"]').value).toBe("Local draft survives")
    expect(field('[name="accentStyle"]').value).toBe("Remote style")
    expect(saveAssistant).not.toHaveBeenCalled()
  })
  it("keeps malformed JSON, invalidates changed tool schemas, and requires explicit sample review", async () => {
    const changed = structuredClone(template.assistant.tools)
    changed[0]!.parameters.properties.question.type = "number"
    await typeInto(field('[name="tools"]'), JSON.stringify(changed))
    await click(button("Switch screen"))
    await validated()
    expect(button("Prepare without calling").disabled).toBe(true)
    expect(container.textContent).toContain("Tool input changed")
    await typeInto(field("#sample-default-0"), "{")
    await validated()
    expect(field("#sample-default-0").value).toBe("{")
    expect(
      button("I reviewed this schema and its sample results").disabled
    ).toBe(true)
    await typeInto(field("#sample-default-0"), "null")
    await validated()
    await click(button("I reviewed this schema and its sample results"))
    await validated()
    expect(button("Prepare without calling").disabled).toBe(false)
    expect(button("Save sample mappings").disabled).toBe(true)
    expect(container.textContent).toContain("These mappings use unsaved tools")
    expect(requests.some((request) => request.options?.method === "PUT")).toBe(
      false
    )
  })
  it("saves authored mappings only explicitly and preserves them on sample revision conflicts", async () => {
    await click(button("Switch screen"))
    await typeInto(field("#sample-default-0"), '{"synthetic":"edited"}')
    await validated()
    expect(requests.some((request) => request.options?.method === "PUT")).toBe(
      false
    )
    sampleReply = () =>
      Response.json(
        { code: "sample_revision_conflict", currentRevision: 3 },
        { status: 409 }
      )
    await click(button("Save sample mappings"))
    const write = requests.find((request) => request.options?.method === "PUT")!
    expect(JSON.parse(String(write.options?.body))).toMatchObject({
      expectedRevision: 2,
      definitions: [{ defaultResult: { synthetic: "edited" } }],
    })
    expect(field("#sample-default-0").value).toBe('{"synthetic":"edited"}')
    expect(store.getSnapshot().sampleConflict).toBe(3)
    expect(button("Save sample mappings").disabled).toBe(true)
    await render({ ...initial, sampleRevision: 3 })
    await click(button("Rebase my draft"))
    await validated()
    sampleReply = () =>
      Response.json({
        revision: 4,
        definitions: JSON.parse(String(requests.at(-1)?.options?.body))
          .definitions,
      })
    await click(button("Save sample mappings"))
    expect(store.getSnapshot().sampleRevision).toBe(4)
    expect(store.getSnapshot().samples[0]!.defaultText).toContain('"edited"')
    expect(saveAssistant).not.toHaveBeenCalled()
  })
  it("locks explicit sample saves synchronously across duplicate clicks", async () => {
    await click(button("Switch screen"))
    await typeInto(field("#sample-default-0"), "null")
    await validated()
    const original = globalThis.fetch
    let release!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>(async (path, options) => {
      if (String(path).endsWith("/csrf"))
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      return original(path, options)
    })
    vi.stubGlobal("fetch", fetch)
    const save = button("Save sample mappings")
    await act(async () => {
      save.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      )
      save.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      )
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().saving).toBe(true)
    await act(async () => {
      release(Response.json({ token: "csrf" }))
    })
    expect(
      requests.filter((request) => request.options?.method === "PUT")
    ).toHaveLength(1)
    expect(store.getSnapshot().saving).toBe(false)
  })

  it("cancels supported same-document Back/Forward traversal before discarding edits", async () => {
    await typeInto(field('[name="instructions"]'), "Keep across history")
    vi.mocked(window.confirm).mockReturnValue(false)
    const event = Object.assign(new Event("navigate", { cancelable: true }), {
      navigationType: "traverse",
      destination: { url: "http://localhost/calls" },
    })
    window.navigation.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(store.getSnapshot().fields.instructions).toBe("Keep across history")
  })

  it("warns before link navigation or closing with an unsaved draft", async () => {
    await typeInto(field('[name="instructions"]'), "Unsaved")
    vi.mocked(window.confirm).mockReturnValue(false)
    const anchor = container.querySelector('a[href="/assistants"]')!
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    await act(async () => {
      anchor.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(window.confirm).toHaveBeenCalledOnce()
    const closing = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(closing)
    expect(closing.defaultPrevented).toBe(true)
    expect(store.getSnapshot().fields.instructions).toBe("Unsaved")
  })
})
