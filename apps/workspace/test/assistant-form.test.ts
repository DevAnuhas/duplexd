import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted above the component import: the editor calls `useRouter` at the top
// of its body, and outside an app router there is no context for it to read.
// One router shared by every render, so navigation can be asserted — a factory
// returning fresh spies would record each call onto an object the test has no
// way to reach.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

import type { ActionResult } from '@/app/actions';
import {
  AssistantForm,
  type AssistantFormValues,
} from '@/app/(app)/assistants/assistant-form';

import {
  blur,
  click,
  control,
  createElement,
  mount,
  submit,
  submittedValues,
  type Mounted,
  type as typeInto,
} from './helpers/assistant-form/render.ts';
import { flatTool } from './helpers/assistant-form/tool-fixtures.ts';

/**
 * The assistant editor, exercised against a real DOM.
 *
 * The editor's hard requirement is not that it looks right — it is that **a
 * save that fails costs the operator nothing**. A twelve-tool assistant is an
 * afternoon of work sitting in an uncontrolled textarea, and every way of
 * losing it looks like ordinary React:
 *
 *  - re-rendering a field from `values` after a rejection,
 *  - letting a collapsed section unmount, taking its control out of `FormData`
 *    so the save quietly writes an empty tool list,
 *  - disabling the fieldset before reading `FormData`, which drops every
 *    disabled control from the submission,
 *  - clearing the secret box, or the "remove the secret" tick, on a failure.
 *
 * Each of those produces a form that still renders and still submits. None is
 * visible in static markup — React emits the identical `value="…"` attribute
 * for `value` and `defaultValue`, so only a live DOM can tell a controlled
 * field from an uncontrolled one, and only a live DOM can be submitted,
 * collapsed or ticked. That is why this file runs under jsdom.
 */

/** A populated assistant, so every case differs in exactly one way. */
function editing(overrides: Partial<AssistantFormValues> = {}): AssistantFormValues {
  return {
    id: 'asst_01',
    name: 'Order desk',
    voice: 'aura-2',
    accentStyle: 'Warm British, unhurried.',
    instructions: 'Answer questions about orders.',
    backendInstructions: 'Prefer lookup_order before escalating.',
    backendModel: 'gpt-4.1-mini',
    waitingBehavior: 'Say "one moment" and stay quiet.',
    serverUrl: 'https://api.example.com/voice',
    tools: [flatTool()],
    hasServerSecret: true,
    ...overrides,
  };
}

/**
 * The shape every stub action is given.
 *
 * Declared as the mock's type parameter rather than as a parameter on the
 * function itself, so `mock.calls` types as a one-element tuple of `FormData`
 * without leaving an argument nothing reads. Untyped, the recorded arguments
 * are `never[]` and every assertion about *what was submitted* — which is most
 * of this file — needs a cast to compile.
 */
type ServerAction = (formData: FormData) => Promise<ActionResult>;

/** An action that rejects with the given issues, recording what it received. */
function rejectingAction(
  issues: Array<{ field: string; message: string }> = [
    { field: 'serverUrl', message: 'That is a loopback address.' },
  ],
) {
  return vi.fn<ServerAction>(async () => ({ ok: false, issues }));
}

/** An action that accepts, optionally reporting the id of a created assistant. */
function acceptingAction(assistantId?: string) {
  return vi.fn<ServerAction>(async () =>
    assistantId === undefined ? { ok: true } : { ok: true, assistantId },
  );
}

/** What a recorded call submitted, under the field name. */
function submittedTo(
  action: ReturnType<typeof vi.fn<ServerAction>>,
  field: string,
  callIndex = 0,
): FormDataEntryValue | null {
  const call = action.mock.calls[callIndex];

  if (call === undefined) {
    throw new Error(`The action was not called ${callIndex + 1} time(s).`);
  }

  return call[0].get(field);
}

/** Mounts the editor over `values`, with `action` as the server action. */
async function editor(
  values: AssistantFormValues,
  action: (formData: FormData) => Promise<ActionResult>,
): Promise<Mounted> {
  return mount(
    createElement(AssistantForm, { values, action, submitLabel: 'Save' }),
  );
}

/** The fields whose contents are the operator's typing, in submission order. */
const TEXT_FIELDS = [
  'name',
  'instructions',
  'voice',
  'accentStyle',
  'waitingBehavior',
  'backendModel',
  'backendInstructions',
  'serverUrl',
  'tools',
] as const;

/** The "Edit as JSON" button that opens and closes the tool editor. */
function toolsToggle(mounted: Mounted): HTMLElement {
  const trigger = mounted.form.querySelector<HTMLElement>(
    '[data-slot="collapsible-trigger"]',
  );

  if (trigger === null) {
    throw new Error('The tools section has no collapsible trigger.');
  }

  return trigger;
}

/** The tick box that asks for the stored secret to be removed. */
function clearSecretBox(mounted: Mounted): HTMLElement | null {
  return mounted.form.querySelector<HTMLElement>('[role="checkbox"]');
}

beforeEach(() => {
  document.body.replaceChildren();
  router.push.mockClear();
  router.replace.mockClear();
  router.refresh.mockClear();
});

describe('every section stays mounted', () => {
  const SECTION_IDS = [
    'identity',
    'conversation',
    'waiting',
    'backend',
    'tool-settings',
  ] as const;

  it('renders all five sections with the tool editor collapsed', async () => {
    const mounted = await editor(editing(), rejectingAction());

    // The collapsed state is the default, so this is the state an operator
    // actually lands in — not one the test had to arrange.
    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    for (const id of SECTION_IDS) {
      expect(mounted.container.querySelector(`#${id}`)).not.toBeNull();
    }

    mounted.unmount();
  });

  /**
   * The failure this guards against is silent and destroys data. Radix
   * unmounts collapsed content unless told otherwise, and an unmounted
   * textarea is not in `FormData` — so the save would write an empty tool list
   * and report success, and the operator would find out at call time.
   */
  it('submits the collapsed tool editor as part of the form', async () => {
    const mounted = await editor(editing(), rejectingAction());

    expect(toolsToggle(mounted).dataset.state).toBe('closed');
    expect(submittedValues(mounted).tools).toContain('lookup_order');

    mounted.unmount();
  });

  it('submits every field while the tool editor is collapsed', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const submitted = submittedValues(mounted);

    for (const field of TEXT_FIELDS) {
      expect(Object.keys(submitted)).toContain(field);
    }

    mounted.unmount();
  });

  /**
   * Collapsing is a view change, not an edit. If opening and closing the
   * editor round-tripped the JSON through the summary, an operator who glanced
   * at it would silently change what gets saved.
   */
  it('keeps typed JSON through an open and close of the tool editor', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const edited = '[{"name":"a","description":"d","parameters":{}}]';

    await typeInto(control(mounted, 'tools'), edited);
    await click(toolsToggle(mounted));
    expect(toolsToggle(mounted).dataset.state).toBe('open');

    await click(toolsToggle(mounted));
    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    expect(control(mounted, 'tools').value).toBe(edited);
    expect(submittedValues(mounted).tools).toBe(edited);

    mounted.unmount();
  });
});

describe('a rejected save costs nothing', () => {
  /** The values an operator typed over the loaded assistant. */
  const typed: Record<string, string> = {
    name: 'Order desk (evening)',
    instructions: 'Answer questions about orders after 6pm.',
    voice: 'aura-2-thalia',
    accentStyle: 'Warm British, slower.',
    waitingBehavior: 'Say "still looking" every few seconds.',
    backendModel: 'gpt-4.1',
    backendInstructions: 'Escalate anything about refunds.',
    serverUrl: 'http://10.0.0.5/voice',
  };

  /** Types every value in `typed` into the mounted editor. */
  async function fillIn(mounted: Mounted): Promise<void> {
    for (const [field, value] of Object.entries(typed)) {
      await typeInto(control(mounted, field), value);
    }
  }

  it('leaves every typed field exactly as it was', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);

    await fillIn(mounted);
    await submit(mounted);

    expect(action).toHaveBeenCalledTimes(1);

    for (const [field, value] of Object.entries(typed)) {
      expect(control(mounted, field).value).toBe(value);
    }

    mounted.unmount();
  });

  /**
   * The tools textarea gets its own assertion rather than riding along with the
   * others, because it is the field where loss is expensive and where a
   * "helpful" reformat is most tempting. The JSON below is deliberately not
   * what `JSON.stringify(…, null, 2)` produces — no indentation, keys out of
   * the canonical order — so anything that round-tripped it would be caught.
   */
  it('leaves the tools JSON byte-for-byte as it was typed', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);
    const raw =
      '[ {"description":"Looks it up.",   "name":"lookup_order",\n' +
      '"parameters":{"type":"object","properties":{"reference":{"type":"string"}}}} ]';

    await typeInto(control(mounted, 'tools'), raw);
    await submit(mounted);

    expect(control(mounted, 'tools').value).toBe(raw);
    expect(submittedTo(action, 'tools')).toBe(raw);

    mounted.unmount();
  });

  /**
   * A server action can reject rather than return — an expired session, a
   * database that went away. The editor must treat that exactly like a
   * validation failure, because from the operator's chair it is the same
   * event: the save did not happen and the work is still on screen.
   */
  it('survives an action that throws', async () => {
    const action = vi.fn<ServerAction>(async () => {
      throw new Error('session expired');
    });
    const mounted = await editor(editing(), action);

    await fillIn(mounted);
    await submit(mounted);

    for (const [field, value] of Object.entries(typed)) {
      expect(control(mounted, field).value).toBe(value);
    }

    expect(mounted.container.textContent).toContain('still here');

    mounted.unmount();
  });

  /**
   * A rejection that left the submit button disabled would hold the operator's
   * work hostage with no way to retry — reloading is the only exit, and it
   * costs them the form.
   */
  it('leaves the form submittable again', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);

    await submit(mounted);

    const button = mounted.form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    expect(button?.disabled).toBe(false);

    await submit(mounted);
    expect(action).toHaveBeenCalledTimes(2);

    mounted.unmount();
  });

  it('shows what went wrong', async () => {
    const mounted = await editor(
      editing(),
      rejectingAction([
        { field: 'serverUrl', message: 'That is a private network address.' },
      ]),
    );

    await submit(mounted);

    expect(mounted.container.textContent).toContain(
      'That is a private network address.',
    );

    mounted.unmount();
  });

  /**
   * A tool list rejected by the server is a tool list the operator has to
   * edit, and it lives behind a collapsed section they would otherwise have to
   * find.
   */
  it('opens the tool editor when the rejection is about tools', async () => {
    const mounted = await editor(
      editing(),
      rejectingAction([{ field: 'tools', message: '"lookup_order" needs a description.' }]),
    );

    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    await submit(mounted);

    expect(toolsToggle(mounted).dataset.state).toBe('open');

    mounted.unmount();
  });

  /**
   * Malformed JSON is caught before the action runs, and that early return is
   * its own path through `onSubmit` — one that sets `issues` without ever
   * setting `busy`. It has to preserve the form just as thoroughly.
   */
  it('preserves everything when the tools JSON is rejected before sending', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);

    await fillIn(mounted);
    await typeInto(control(mounted, 'tools'), '[{"name": "half-typed');
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();

    for (const [field, value] of Object.entries(typed)) {
      expect(control(mounted, field).value).toBe(value);
    }

    expect(control(mounted, 'tools').value).toBe('[{"name": "half-typed');

    mounted.unmount();
  });
});

describe('the webhook secret', () => {
  /**
   * The server never sends the secret, so there is nothing to prefill. A masked
   * placeholder of the real length would leak that length and imply a
   * round-trip that does not happen.
   */
  it('starts empty even when one is stored', async () => {
    const mounted = await editor(
      editing({ hasServerSecret: true }),
      rejectingAction(),
    );

    expect(control(mounted, 'serverSecret').value).toBe('');
    expect(mounted.container.textContent).toContain('A secret is set');

    mounted.unmount();
  });

  it('starts empty when none is stored', async () => {
    const mounted = await editor(
      editing({ hasServerSecret: false }),
      rejectingAction(),
    );

    expect(control(mounted, 'serverSecret').value).toBe('');
    expect(mounted.container.textContent).toContain('No secret is set');

    mounted.unmount();
  });

  it('is a password field, so it is never shown or autofilled', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const secret = control(mounted, 'serverSecret') as HTMLInputElement;

    expect(secret.type).toBe('password');
    expect(secret.autocomplete).toBe('new-password');

    mounted.unmount();
  });

  /**
   * Retyping a secret after a failed save is the most annoying possible
   * outcome, because it is the one field the operator cannot copy back off the
   * screen.
   */
  it('keeps a newly typed secret through a rejection', async () => {
    const mounted = await editor(editing(), rejectingAction());

    await typeInto(control(mounted, 'serverSecret'), 'whsec_typed_once');
    await submit(mounted);

    expect(control(mounted, 'serverSecret').value).toBe('whsec_typed_once');

    mounted.unmount();
  });

  it('sends a blank secret when the operator did not type one', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);

    await submit(mounted);

    expect(submittedTo(action, 'serverSecret')).toBe('');

    mounted.unmount();
  });
});

describe('removing a stored secret', () => {
  /**
   * Clearing must be an explicit act. If a blank box meant "remove it", every
   * save that touched another field would silently drop the webhook secret and
   * break delivery.
   */
  it('is offered only when a secret is stored', async () => {
    const withSecret = await editor(
      editing({ hasServerSecret: true }),
      rejectingAction(),
    );

    expect(clearSecretBox(withSecret)).not.toBeNull();
    withSecret.unmount();

    const without = await editor(
      editing({ hasServerSecret: false }),
      rejectingAction(),
    );

    expect(clearSecretBox(without)).toBeNull();
    without.unmount();
  });

  it('starts unticked and submits nothing', async () => {
    const mounted = await editor(editing(), rejectingAction());

    expect(clearSecretBox(mounted)?.dataset.state).toBe('unchecked');
    expect(submittedValues(mounted)).not.toHaveProperty('clearServerSecret');

    mounted.unmount();
  });

  it('submits only once it has been ticked', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);
    const box = clearSecretBox(mounted);

    expect(box).not.toBeNull();
    await click(box!);

    expect(box?.dataset.state).toBe('checked');
    expect(submittedValues(mounted).clearServerSecret).toBe('on');

    await submit(mounted);

    expect(submittedTo(action, 'clearServerSecret')).toBe('on');

    mounted.unmount();
  });

  /**
   * The tick is a deliberate, destructive instruction. Silently untick-ing it
   * on a rejection would mean a retried save quietly kept a secret the
   * operator had asked to remove.
   */
  it('stays ticked through a rejected save', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const box = clearSecretBox(mounted);

    await click(box!);
    await submit(mounted);

    expect(clearSecretBox(mounted)?.dataset.state).toBe('checked');
    expect(submittedValues(mounted).clearServerSecret).toBe('on');

    mounted.unmount();
  });

  it('can be unticked again', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const box = clearSecretBox(mounted);

    await click(box!);
    await click(box!);

    expect(box?.dataset.state).toBe('unchecked');
    expect(submittedValues(mounted)).not.toHaveProperty('clearServerSecret');

    mounted.unmount();
  });
});

describe('the tool summary beside the editor', () => {
  it('describes the loaded tools without the operator opening the JSON', async () => {
    const mounted = await editor(editing(), rejectingAction());

    expect(mounted.container.textContent).toContain('lookup_order');
    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    mounted.unmount();
  });

  it('says so plainly when there are no tools', async () => {
    const mounted = await editor(editing({ tools: [] }), rejectingAction());

    expect(mounted.container.textContent).toContain('No tools configured');

    mounted.unmount();
  });

  /**
   * The summary is a view of the textarea, never a source for it. Re-reading it
   * after a refresh must not disturb what is in the box.
   */
  it('refreshes on blur without rewriting the textarea', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const tools = control(mounted, 'tools');
    const raw =
      '[ {"name":"refunds","description":"Issues a refund.","parameters":{}} ]';

    expect(mounted.container.textContent).toContain('lookup_order');

    await typeInto(tools, raw);
    await blur(tools);

    // The summary caught up — without this the test would pass on an editor
    // whose `onBlur` never ran, since the textarea holds what it was given
    // either way.
    expect(mounted.container.textContent).toContain('refunds');
    expect(mounted.container.textContent).not.toContain('lookup_order');

    // ...and the bytes are still the operator's, spacing included.
    expect(tools.value).toBe(raw);
    expect(submittedValues(mounted).tools).toBe(raw);

    mounted.unmount();
  });

  /**
   * A half-typed list must report itself without destroying anything. The
   * summary goes to an error state; the textarea keeps exactly what is in it.
   */
  it('reports malformed JSON on blur and still keeps the text', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const tools = control(mounted, 'tools');

    await typeInto(tools, '[{"name":"half-typed');
    await blur(tools);

    expect(mounted.container.textContent).toContain('valid JSON');
    expect(tools.value).toBe('[{"name":"half-typed');
    expect(submittedValues(mounted).tools).toBe('[{"name":"half-typed');

    mounted.unmount();
  });
});

describe('a save that succeeds', () => {
  /**
   * The mirror of the preservation tests, and the reason they are not
   * vacuously true. An editor that never cleared anything would pass every
   * assertion about a rejection while leaving a used credential sitting in the
   * DOM — so the one field that *must* be cleared on success is checked here,
   * along with the fields that must not be.
   */
  it('clears the secret box and nothing else', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'name'), 'Order desk (evening)');
    await typeInto(control(mounted, 'serverSecret'), 'whsec_new_value');
    await submit(mounted);

    expect(submittedTo(action, 'serverSecret')).toBe('whsec_new_value');
    expect(control(mounted, 'serverSecret').value).toBe('');
    expect(control(mounted, 'name').value).toBe('Order desk (evening)');

    mounted.unmount();
  });

  it('unticks the remove-the-secret box once it has been acted on', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await click(clearSecretBox(mounted)!);
    expect(clearSecretBox(mounted)?.dataset.state).toBe('checked');

    await submit(mounted);

    expect(submittedTo(action, 'clearServerSecret')).toBe('on');

    // The stored secret is gone, so the box that removes it is gone too.
    expect(clearSecretBox(mounted)).toBeNull();
    expect(mounted.container.textContent).toContain('No secret is set');

    mounted.unmount();
  });

  /**
   * Resetting the tick after a successful clear re-renders Radix's hidden
   * checkbox, and a `change` from that input bubbles to the form's `onChange`
   * — which marks the form dirty. The operator would then be told they have
   * unsaved changes immediately after a save that worked, and the only way to
   * clear it is another save.
   *
   * Worth its own test because it is the *success* path misreporting itself:
   * nothing is lost and nothing errors, so it shows up only as a status line
   * that contradicts what just happened.
   */
  it('does not report unsaved changes after clearing a secret', async () => {
    const mounted = await editor(editing(), acceptingAction());

    await click(clearSecretBox(mounted)!);
    await submit(mounted);

    expect(mounted.container.textContent).toContain('Saved');
    expect(mounted.container.textContent).not.toContain('Unsaved changes');

    mounted.unmount();
  });

  it('does not report unsaved changes after replacing a secret', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'serverSecret'), 'whsec_replacement');
    await submit(mounted);

    expect(submittedTo(action, 'serverSecret')).toBe('whsec_replacement');
    expect(control(mounted, 'serverSecret').value).toBe('');
    expect(mounted.container.textContent).toContain('Saved');
    expect(mounted.container.textContent).not.toContain('Unsaved changes');

    mounted.unmount();
  });

  it('reports that the assistant now has a secret', async () => {
    const mounted = await editor(
      editing({ hasServerSecret: false }),
      acceptingAction(),
    );

    expect(mounted.container.textContent).toContain('No secret is set');

    await typeInto(control(mounted, 'serverSecret'), 'whsec_first');
    await submit(mounted);

    expect(mounted.container.textContent).toContain('A secret is set');

    mounted.unmount();
  });

  /**
   * This test doubles as the harness's own canary.
   *
   * "Unsaved changes" is driven by the form's `onChange`, which only runs if
   * React genuinely saw the typing — and React silently stops delivering
   * `onChange` if `react-dom` was imported before a DOM existed. Under that
   * fault the DOM value still updates, so every assertion in this file about
   * *what the form submits* keeps passing while the component's own state
   * handlers never run. Asserting the dirty indicator here is what makes that
   * failure loud instead of invisible, so it is load-bearing beyond the status
   * line it checks.
   */
  it('reports unsaved changes, then a save', async () => {
    const mounted = await editor(editing(), acceptingAction());

    await typeInto(control(mounted, 'name'), 'Order desk (evening)');
    expect(mounted.container.textContent).toContain('Unsaved changes');

    await submit(mounted);

    expect(mounted.container.textContent).toContain('Saved');
    expect(mounted.container.textContent).not.toContain('Unsaved changes');

    mounted.unmount();
  });

  /**
   * The live title is the other thing only a real `onChange` can drive, and it
   * fails in the same silent way. Kept separate so a regression says which of
   * the two broke.
   */
  it('retitles the page as the name is typed', async () => {
    const mounted = await editor(editing(), acceptingAction());

    await typeInto(control(mounted, 'name'), 'Evening order desk');

    expect(mounted.container.querySelector('h1')?.textContent).toBe(
      'Evening order desk',
    );

    mounted.unmount();
  });

  /**
   * Creating and editing diverge only here. A new assistant has no URL until
   * the server gives it an id, so the editor has to move to it — otherwise a
   * second save would create a second assistant.
   */
  it('moves a newly created assistant to its own URL', async () => {
    const mounted = await editor(
      editing({ id: undefined, hasServerSecret: false }),
      acceptingAction('asst_new'),
    );

    await submit(mounted);

    expect(router.replace).toHaveBeenCalledWith('/assistants/asst_new?saved=1');

    mounted.unmount();
  });

  it('leaves an existing assistant where it is', async () => {
    const mounted = await editor(editing({ id: 'asst_01' }), acceptingAction());

    await submit(mounted);

    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();

    mounted.unmount();
  });

  /**
   * A create whose action returns no id has nowhere to navigate to. Guessing a
   * URL would be worse than staying put, and throwing on `undefined` would lose
   * the form after a save that actually worked.
   */
  it('stays put when a create reports no id', async () => {
    const mounted = await editor(
      editing({ id: undefined }),
      acceptingAction(),
    );

    await submit(mounted);

    expect(router.replace).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain('Saved');

    mounted.unmount();
  });
});
