// Must stay first: it installs the DOM, and `react-dom` decides at import time
// which event machinery it can use. See the file itself for what breaks.
import "./dom-environment.ts"

import { act, createElement, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"

/**
 * Mounting for the assistant editor's tests.
 *
 * Deliberately `react-dom/client` and React's own `act` rather than a testing
 * library. The editor's contract is about the *DOM*: whether an input is
 * controlled, whether a collapsed section is still a form participant, what
 * `new FormData(form)` sees. A library that hands back queried elements adds a
 * layer between the assertion and the thing being asserted, and the assertions
 * here are short enough not to need one.
 *
 * `renderToStaticMarkup` was tried first and cannot do this job: React renders
 * `value` and `defaultValue` to the identical `value="…"` attribute, so static
 * markup cannot tell a controlled field from an uncontrolled one — which is the
 * single invariant the editor most needs held. Nor can markup be submitted,
 * collapsed or clicked.
 */

export type Mounted = {
  container: HTMLElement
  form: HTMLFormElement
  unmount: () => void
}

/** Mounts an element into a detached container and returns DOM handles. */
export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div")
  document.body.append(container)

  let root: Root

  await act(async () => {
    root = createRoot(container)
    root.render(element)
  })

  const form = container.querySelector("form")

  if (form === null) {
    throw new Error("The rendered tree has no form.")
  }

  return {
    container,
    form,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

/** Runs `work` and flushes every update and transition it schedules. */
export async function flush(work: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await work()
  })
}

/**
 * The form control carrying `name`, as the DOM sees it.
 *
 * Looked up by `name` rather than by `id` on purpose: `name` is what decides
 * whether a control reaches `FormData`, which is what the editor's preservation
 * guarantees are ultimately about.
 */
export function control(
  mounted: Mounted,
  name: string
): HTMLInputElement | HTMLTextAreaElement {
  const element = mounted.form.querySelector(`[name="${name}"]`)

  if (element === null) {
    throw new Error(`No form control is named "${name}".`)
  }

  return element as HTMLInputElement | HTMLTextAreaElement
}

/** Every value the form would submit right now, as plain entries. */
export function submittedValues(mounted: Mounted): Record<string, string> {
  const entries: Record<string, string> = {}

  for (const [key, value] of new FormData(mounted.form).entries()) {
    if (typeof value === "string") {
      entries[key] = value
    }
  }

  return entries
}

/**
 * Types `text` into a control so that both the DOM **and React** see it.
 *
 * Setting `.value` and dispatching an event is not enough on its own. React
 * installs a value tracker on each controlled-or-not input and fires `onChange`
 * only when the tracker's cached value differs from the node's — a deliberate
 * de-duplication, since the browser emits `input` for things that do not change
 * the value. Whichever way the assignment happens, the tracker ends up holding
 * the new text, React concludes nothing changed, and `onChange` never runs.
 *
 * That failure is quiet and it is dangerous in exactly this suite: the DOM
 * value updates, so an assertion about what the form submits still passes,
 * while the component's own state handlers — the ones that mark the form dirty
 * and retitle it — never ran. The test would be asserting against a component
 * that never received the input.
 *
 * So the tracker is explicitly rewound to the previous value before the event
 * is dispatched. React then sees a genuine change, exactly as it would from a
 * keystroke.
 */
export async function type(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string
): Promise<void> {
  const previous = element.value

  await flush(() => {
    element.value = text

    const tracker = (
      element as unknown as {
        _valueTracker?: { setValue: (value: string) => void }
      }
    )._valueTracker

    if (tracker === undefined) {
      throw new Error(
        "React installed no value tracker on this control, so it cannot be " +
          "typed into reliably. Check that the element was rendered by React."
      )
    }

    tracker.setValue(previous)

    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

/** Submits the form the way its submit button does. */
export async function submit(mounted: Mounted): Promise<void> {
  await flush(() => {
    mounted.form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    )
  })
}

/**
 * Moves focus off `element`, flushing whatever React schedules in response.
 *
 * Dispatches `focusout`, not `blur`. React delegates from the root container,
 * and `blur` does not bubble — so a dispatched `blur` reaches no React listener
 * at all, and an `onBlur` handler silently never runs. The test still sees the
 * DOM value it set moments earlier and passes, having exercised nothing.
 */
export async function blur(element: Element): Promise<void> {
  await flush(() => {
    element.dispatchEvent(new Event("focusout", { bubbles: true }))
  })
}

/** Clicks an element, flushing whatever React schedules in response. */
export async function click(element: Element): Promise<void> {
  await flush(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    )
  })
}

export { createElement }
