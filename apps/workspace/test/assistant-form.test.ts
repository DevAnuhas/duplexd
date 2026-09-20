import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted above the component import. One router and one toast shared by every
// render, so both can be asserted — a factory returning fresh spies would
// record each call onto an object the test has no way to reach.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast }));

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
  type Mounted,
  type as typeInto,
} from './helpers/assistant-form/render.ts';
import { flatTool } from './helpers/assistant-form/tool-fixtures.ts';

/**
 * The assistant editor, exercised against a real DOM.
 *
 * The editor's hard requirement is not that it looks right — it is that **a
 * save that fails costs the operator nothing**. A twelve-tool assistant is an
 * afternoon of work, and every way of losing it looks like ordinary React.
 *
 * Since the move to react-hook-form the shape of that risk has changed, and so
 * have these tests. The form no longer submits itself: `handleSubmit` hands the
 * validated values to a callback which builds the `FormData` by hand. So **what
 * the DOM would submit is no longer the contract** — what the *action receives*
 * is. Asserting `new FormData(form)` would now be checking a path the
 * application does not use, which is why nearly every submission assertion
 * below reads from the recorded call instead.
 *
 * What the controlled inputs buy in return is a stronger guarantee than the
 * uncontrolled ones gave. Under `Controller`, React re-renders each input from
 * form state — so if typing failed to reach react-hook-form, React would
 * immediately write the *old* value back over the DOM. `expect(field.value)`
 * therefore proves the library received the keystroke, which under the previous
 * uncontrolled form it did not.
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
 * without leaving an argument nothing reads.
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

/** Every key a recorded call submitted. */
function submittedKeys(
  action: ReturnType<typeof vi.fn<ServerAction>>,
  callIndex = 0,
): string[] {
  const call = action.mock.calls[callIndex];

  if (call === undefined) {
    throw new Error(`The action was not called ${callIndex + 1} time(s).`);
  }

  return [...call[0].keys()];
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

/** The fields the operator types into, all of which must reach the action. */
const TEXT_FIELDS = [
  'name',
  'instructions',
  'voice',
  'accentStyle',
  'waitingBehavior',
  'backendModel',
  'backendInstructions',
  'serverUrl',
  'serverSecret',
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

/** The header's live status text — "Saving…", "Unsaved changes", or nothing. */
function status(mounted: Mounted): string {
  return (
    mounted.form.querySelector('[role="status"]')?.textContent?.trim() ?? ''
  );
}

/** The live page title, which follows the name field. */
function heading(mounted: Mounted): string {
  return mounted.container.querySelector('h1')?.textContent?.trim() ?? '';
}

/**
 * The text of the tools section's summary, above the JSON editor.
 *
 * Scoped deliberately. A tool name is an ordinary word an operator may well
 * have typed into the instructions too, so a negative assertion against the
 * whole form could never go false and would read as coverage.
 */
function toolSummary(mounted: Mounted): string {
  const section = mounted.container.querySelector('#tool-settings');

  if (section === null) {
    throw new Error('There is no tools section.');
  }

  const table = section.querySelector('table');

  return (table ?? section).textContent ?? '';
}

/** Whether any message anywhere in the form says `text`. */
function showsMessage(mounted: Mounted, text: string): boolean {
  return (mounted.form.textContent ?? '').includes(text);
}

beforeEach(() => {
  document.body.replaceChildren();
  router.push.mockClear();
  router.replace.mockClear();
  router.refresh.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
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
   * The failure this guards against is silent and destroys data. Radix unmounts
   * collapsed content unless told otherwise, and an unmounted `Controller`
   * takes its value out of the submission — so the save would write an empty
   * tool list and report success, and the operator would find out at call time.
   */
  it('sends the collapsed tool editor to the action', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    await submit(mounted);

    expect(submittedTo(action, 'tools')).toContain('lookup_order');

    mounted.unmount();
  });

  it('sends every field while the tool editor is collapsed', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await submit(mounted);

    for (const field of TEXT_FIELDS) {
      expect(submittedKeys(action)).toContain(field);
    }

    mounted.unmount();
  });

  /**
   * Collapsing is a view change, not an edit. If opening and closing the editor
   * round-tripped the JSON through the summary, an operator who glanced at it
   * would silently change what gets saved.
   */
  it('keeps typed JSON through an open and close of the tool editor', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);
    const edited = '[{"name":"a","description":"d","parameters":{}}]';

    await typeInto(control(mounted, 'tools'), edited);
    await click(toolsToggle(mounted));
    expect(toolsToggle(mounted).dataset.state).toBe('open');

    await click(toolsToggle(mounted));
    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    expect(control(mounted, 'tools').value).toBe(edited);

    await submit(mounted);
    expect(submittedTo(action, 'tools')).toBe(edited);

    mounted.unmount();
  });
});

describe('the schema gate, before anything is sent', () => {
  /**
   * The editor is `noValidate`, so nothing the browser does stops a bad
   * submission — the schema is the only thing between the operator and a
   * pointless round trip. Each case asserts the action was **not called**,
   * because "it was rejected" and "it was rejected before being sent" are
   * different guarantees and only the second one is worth having here.
   */
  it('refuses an empty name and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'name'), '');
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();
    expect(showsMessage(mounted, 'An assistant needs a name.')).toBe(true);
    expect(toast.error).toHaveBeenCalled();

    mounted.unmount();
  });

  /**
   * A name of spaces renders as an empty heading and is indistinguishable from
   * an unnamed assistant in a call history.
   */
  it('refuses a whitespace-only name and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'name'), '   ');
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();
    expect(showsMessage(mounted, 'An assistant needs a name.')).toBe(true);

    mounted.unmount();
  });

  it('refuses a name over the length limit and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'name'), 'a'.repeat(121));
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();
    expect(
      showsMessage(mounted, 'Assistant name must be 120 characters or fewer.'),
    ).toBe(true);

    mounted.unmount();
  });

  it('accepts a name at the limit and sends it', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);
    const longest = 'a'.repeat(120);

    await typeInto(control(mounted, 'name'), longest);
    await submit(mounted);

    expect(submittedTo(action, 'name')).toBe(longest);

    mounted.unmount();
  });

  it('refuses a server URL that is not a URL and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'serverUrl'), 'api.example.com');
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();
    expect(
      showsMessage(mounted, 'Server URL must be a valid HTTP or HTTPS URL.'),
    ).toBe(true);

    mounted.unmount();
  });

  it('refuses a server URL with an unusable scheme and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'serverUrl'), 'ftp://example.com/voice');
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();

    mounted.unmount();
  });

  /**
   * The other half of the authority split, asserted through the UI rather than
   * only at the schema. Whether an `http:` address may be stored depends on
   * `ALLOW_LOOPBACK_SERVER_URL` and on the address, which the browser cannot
   * know — so the editor must send it and let the server answer. A client that
   * guessed would leave the operator pressing Save with nothing happening and
   * no message anywhere.
   */
  it('sends an http URL for the server to rule on', async () => {
    const action = rejectingAction([
      { field: 'serverUrl', message: 'That is a loopback address.' },
    ]);
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'serverUrl'), 'http://localhost:3000/voice');
    await submit(mounted);

    expect(submittedTo(action, 'serverUrl')).toBe('http://localhost:3000/voice');
    expect(showsMessage(mounted, 'That is a loopback address.')).toBe(true);

    mounted.unmount();
  });

  it('accepts a blank server URL, which is optional', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'serverUrl'), '');
    await submit(mounted);

    expect(submittedTo(action, 'serverUrl')).toBe('');

    mounted.unmount();
  });

  it('refuses malformed tools JSON and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'tools'), '[{"name": "half-typed');
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();
    expect(showsMessage(mounted, 'Tools must be valid JSON')).toBe(true);

    mounted.unmount();
  });

  it('refuses tools that are not a list and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'tools'), '{"name":"lookup_order"}');
    await submit(mounted);

    expect(action).not.toHaveBeenCalled();
    expect(showsMessage(mounted, 'Tools must be a list.')).toBe(true);

    mounted.unmount();
  });

  /**
   * Per-tool rules stay on the server. A list whose *members* are nonsense is a
   * well-formed array, so the client lets it through and `validateTools`
   * answers with a message naming the offending tool — the one place those
   * rules live.
   */
  it('sends a well-formed array whose members are not tools', async () => {
    const action = rejectingAction([
      { field: 'tools', message: 'tool 1 is not an object.' },
    ]);
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'tools'), '[1,2,3]');
    await submit(mounted);

    expect(submittedTo(action, 'tools')).toBe('[1,2,3]');
    expect(showsMessage(mounted, 'tool 1 is not an object.')).toBe(true);

    mounted.unmount();
  });

  it('opens the tool editor when the schema rejects the JSON', async () => {
    const mounted = await editor(editing(), acceptingAction());

    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    await typeInto(control(mounted, 'tools'), 'not json');
    await submit(mounted);

    expect(toolsToggle(mounted).dataset.state).toBe('open');

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
    serverUrl: 'https://api.example.com/evening',
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
    const action = rejectingAction([
      { field: 'tools', message: '"lookup_order" needs a description.' },
    ]);
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
   * validation failure, because from the operator's chair it is the same event:
   * the save did not happen and the work is still on screen.
   *
   * The message for this one is a **root** error, which the form does not
   * render inline, so the toast is the only place it appears. Asserting the
   * toast is therefore asserting the operator was told at all.
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

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Your edits are still here'),
    );

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

  it('shows what went wrong, beside the field and in a toast', async () => {
    const mounted = await editor(
      editing(),
      rejectingAction([
        { field: 'serverUrl', message: 'That is a private network address.' },
      ]),
    );

    await submit(mounted);

    expect(showsMessage(mounted, 'That is a private network address.')).toBe(
      true,
    );
    expect(toast.error).toHaveBeenCalled();

    mounted.unmount();
  });

  /**
   * A tool list rejected by the server is a tool list the operator has to edit,
   * and it lives behind a collapsed section they would otherwise have to find.
   */
  it('opens the tool editor when the rejection is about tools', async () => {
    const mounted = await editor(
      editing(),
      rejectingAction([
        { field: 'tools', message: '"lookup_order" needs a description.' },
      ]),
    );

    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    await submit(mounted);

    expect(toolsToggle(mounted).dataset.state).toBe('open');

    mounted.unmount();
  });

  /**
   * `validateTools` reports one issue per broken tool, so a list with three
   * mistakes comes back as three issues **on the same field**. React-hook-form
   * holds one error per field, so the naive loop — `setError` per issue —
   * leaves only the last one standing and the operator fixes one problem per
   * round trip, learning about the next only after saving again.
   *
   * Asserted with two messages on one field rather than one each on two, since
   * only the same-field case can regress this way.
   */
  it('shows every server message for a field, not just the last', async () => {
    const mounted = await editor(
      editing(),
      rejectingAction([
        { field: 'tools', message: '"lookup_order" needs a description.' },
        { field: 'tools', message: '"cancel_order" needs a parameters object.' },
      ]),
    );

    await submit(mounted);

    expect(showsMessage(mounted, '"lookup_order" needs a description.')).toBe(
      true,
    );
    expect(
      showsMessage(mounted, '"cancel_order" needs a parameters object.'),
    ).toBe(true);

    mounted.unmount();
  });

  it('places each field’s own message against that field', async () => {
    const mounted = await editor(
      editing(),
      rejectingAction([
        { field: 'name', message: 'An assistant needs a name.' },
        { field: 'serverUrl', message: 'That is a private network address.' },
      ]),
    );

    await submit(mounted);

    const nameError = mounted.container.querySelector('#name-error');
    const urlError = mounted.container.querySelector('#serverUrl-error');

    expect(nameError?.textContent).toContain('An assistant needs a name.');
    expect(urlError?.textContent).toContain(
      'That is a private network address.',
    );

    mounted.unmount();
  });

  /** The work is still unsaved, and the header has to keep saying so. */
  it('still reports unsaved changes', async () => {
    const mounted = await editor(editing(), rejectingAction());

    await fillIn(mounted);
    await submit(mounted);

    expect(status(mounted)).toBe('Unsaved changes');

    mounted.unmount();
  });
});

describe('the webhook secret', () => {
  /**
   * The server never sends the secret, so there is nothing to prefill. A masked
   * placeholder of the real length would leak that length and imply a round
   * trip that does not happen.
   */
  it('starts empty even when one is stored', async () => {
    const mounted = await editor(
      editing({ hasServerSecret: true }),
      rejectingAction(),
    );

    expect(control(mounted, 'serverSecret').value).toBe('');
    expect(showsMessage(mounted, 'A secret is set')).toBe(true);

    mounted.unmount();
  });

  it('starts empty when none is stored', async () => {
    const mounted = await editor(
      editing({ hasServerSecret: false }),
      rejectingAction(),
    );

    expect(control(mounted, 'serverSecret').value).toBe('');
    expect(showsMessage(mounted, 'No secret is set')).toBe(true);

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

  it('starts unticked and sends nothing', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    expect(clearSecretBox(mounted)?.dataset.state).toBe('unchecked');

    await submit(mounted);

    expect(submittedKeys(action)).not.toContain('clearServerSecret');

    mounted.unmount();
  });

  it('sends the instruction only once it has been ticked', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);
    const box = clearSecretBox(mounted);

    expect(box).not.toBeNull();
    await click(box!);

    expect(box?.dataset.state).toBe('checked');

    await submit(mounted);

    expect(submittedTo(action, 'clearServerSecret')).toBe('on');

    mounted.unmount();
  });

  /**
   * The tick is a deliberate, destructive instruction. Silently unticking it on
   * a rejection would mean a retried save quietly kept a secret the operator
   * had asked to remove.
   */
  it('stays ticked through a rejected save', async () => {
    const action = rejectingAction();
    const mounted = await editor(editing(), action);

    await click(clearSecretBox(mounted)!);
    await submit(mounted);

    expect(clearSecretBox(mounted)?.dataset.state).toBe('checked');

    await submit(mounted);
    expect(submittedTo(action, 'clearServerSecret', 1)).toBe('on');

    mounted.unmount();
  });

  it('can be unticked again', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);
    const box = clearSecretBox(mounted);

    await click(box!);
    await click(box!);

    expect(box?.dataset.state).toBe('unchecked');

    await submit(mounted);
    expect(submittedKeys(action)).not.toContain('clearServerSecret');

    mounted.unmount();
  });
});

describe('the tool summary beside the editor', () => {
  it('describes the loaded tools without the operator opening the JSON', async () => {
    const mounted = await editor(editing(), rejectingAction());

    expect(toolSummary(mounted)).toContain('lookup_order');
    expect(toolsToggle(mounted).dataset.state).toBe('closed');

    mounted.unmount();
  });

  it('says so plainly when there are no tools', async () => {
    const mounted = await editor(editing({ tools: [] }), rejectingAction());

    expect(toolSummary(mounted)).toContain('No tools configured');

    mounted.unmount();
  });

  /**
   * The summary is a view of the textarea, never a source for it. Refreshing it
   * must not disturb what is in the box.
   */
  it('refreshes on blur without rewriting the textarea', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const tools = control(mounted, 'tools');
    const raw =
      '[ {"name":"refunds","description":"Issues a refund.","parameters":{}} ]';

    expect(toolSummary(mounted)).toContain('lookup_order');

    await typeInto(tools, raw);
    await blur(tools);

    // The summary caught up — without this the test would pass on an editor
    // whose `onBlur` never ran, since the textarea holds what it was given
    // either way. Read from the summary rather than the whole form: the
    // backend-instructions field legitimately mentions `lookup_order` too, and
    // a form-wide search would never go false.
    expect(toolSummary(mounted)).toContain('refunds');
    expect(toolSummary(mounted)).not.toContain('lookup_order');

    // ...and the bytes are still the operator's, spacing included.
    expect(tools.value).toBe(raw);

    mounted.unmount();
  });

  /**
   * A half-typed list reports itself in two places for two different reasons:
   * the summary says it cannot describe the JSON, and the schema says why. The
   * textarea keeps exactly what is in it.
   */
  it('reports malformed JSON on blur and still keeps the text', async () => {
    const mounted = await editor(editing(), rejectingAction());
    const tools = control(mounted, 'tools');

    await typeInto(tools, '[{"name":"half-typed');
    await blur(tools);

    expect(toolSummary(mounted)).toContain('Tool summary unavailable');
    expect(showsMessage(mounted, 'Tools must be valid JSON')).toBe(true);
    expect(tools.value).toBe('[{"name":"half-typed');

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
    expect(showsMessage(mounted, 'No secret is set')).toBe(true);

    mounted.unmount();
  });

  it('reports that the assistant now has a secret', async () => {
    const mounted = await editor(
      editing({ hasServerSecret: false }),
      acceptingAction(),
    );

    expect(showsMessage(mounted, 'No secret is set')).toBe(true);

    await typeInto(control(mounted, 'serverSecret'), 'whsec_first');
    await submit(mounted);

    expect(showsMessage(mounted, 'A secret is set')).toBe(true);

    mounted.unmount();
  });

  /**
   * Success is announced by a toast and by the header falling silent — there is
   * no inline "Saved" any more, because the toast survives the navigation a
   * newly created assistant performs and an inline status would not.
   */
  it('announces itself with a toast and no inline status', async () => {
    const mounted = await editor(editing(), acceptingAction());

    await typeInto(control(mounted, 'name'), 'Order desk (evening)');
    expect(status(mounted)).toBe('Unsaved changes');

    await submit(mounted);

    expect(toast.success).toHaveBeenCalledWith('Saved');
    expect(status(mounted)).toBe('');

    mounted.unmount();
  });

  /**
   * The reset makes the submitted values the new baseline. Without that the
   * form stays dirty after a successful save, so the header contradicts the
   * toast and a second save re-sends work the server already has.
   */
  it('takes the saved values as the new baseline', async () => {
    const action = acceptingAction();
    const mounted = await editor(editing(), action);

    await typeInto(control(mounted, 'name'), 'Order desk (evening)');
    await submit(mounted);

    expect(status(mounted)).toBe('');

    // Still dirty-free after a second look, and the value is the saved one.
    expect(control(mounted, 'name').value).toBe('Order desk (evening)');

    await typeInto(control(mounted, 'name'), 'Order desk (night)');
    expect(status(mounted)).toBe('Unsaved changes');

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

    // No `?saved=1`: the toast carries the confirmation across the navigation,
    // so the query parameter that used to re-announce it is gone.
    expect(router.replace).toHaveBeenCalledWith('/assistants/asst_new');
    expect(toast.success).toHaveBeenCalledWith('Saved');

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
    const mounted = await editor(editing({ id: undefined }), acceptingAction());

    await submit(mounted);

    expect(router.replace).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Saved');

    mounted.unmount();
  });
});

describe('the editor keeps up with typing', () => {
  /**
   * These two are the harness's own canaries.
   *
   * Both are driven by state that only updates if react-hook-form genuinely
   * received the keystroke. If the wiring between the DOM and `Controller`
   * broke, a great many assertions in this file would keep passing — so one
   * test whose whole job is to fail in that case is worth more than its
   * subject suggests.
   */
  it('retitles the page as the name is typed', async () => {
    const mounted = await editor(editing(), acceptingAction());

    expect(heading(mounted)).toBe('Order desk');

    await typeInto(control(mounted, 'name'), 'Evening order desk');

    expect(heading(mounted)).toBe('Evening order desk');

    mounted.unmount();
  });

  it('falls back to a placeholder title when the name is cleared', async () => {
    const mounted = await editor(editing(), acceptingAction());

    await typeInto(control(mounted, 'name'), '');

    expect(heading(mounted)).toBe('New assistant');

    mounted.unmount();
  });

  it('reports unsaved changes as soon as anything is edited', async () => {
    const mounted = await editor(editing(), acceptingAction());

    expect(status(mounted)).toBe('');

    await typeInto(control(mounted, 'voice'), 'aura-2-thalia');

    expect(status(mounted)).toBe('Unsaved changes');

    mounted.unmount();
  });

  it('reports unsaved changes when only the tick box is touched', async () => {
    const mounted = await editor(editing(), acceptingAction());

    expect(status(mounted)).toBe('');

    await click(clearSecretBox(mounted)!);

    expect(status(mounted)).toBe('Unsaved changes');

    mounted.unmount();
  });
});
