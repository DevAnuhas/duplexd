import { JSDOM } from 'jsdom';

/**
 * Installs a DOM, as a side effect, before anything imports React.
 *
 * **Import order is the whole point of this file.** `react-dom` decides at
 * module-evaluation time which event machinery it can use — among other things
 * it feature-detects support for the `input` event, and that detection is
 * skipped entirely when there is no `document` at the moment it loads. A React
 * that loaded without a DOM still renders, still delivers clicks, and still
 * fires `onInput`; what it silently stops doing is firing `onChange` for typed
 * input. The tests go green on everything that reads the DOM and quietly stop
 * exercising the component's own change handlers.
 *
 * ES imports are evaluated before the body of the module that declares them, so
 * a DOM built in the body of `render.ts` would arrive *after* `react-dom` had
 * already made that decision. Splitting it into this module fixes the ordering:
 * a module is evaluated when it is first imported, and imports are evaluated in
 * source order, so `import './dom-environment.ts'` placed above the React
 * imports runs first. Anything importing the render helpers must keep this
 * first — which `render.ts` does on their behalf.
 *
 * ---
 *
 * The DOM is built here rather than by `@vitest-environment jsdom`, which would
 * otherwise be the obvious way to guarantee the same ordering.
 *
 * Under vitest's jsdom environment, setup files are evaluated against the jsdom
 * document's base URL, so `import.meta.url` inside them is an `http:` URL. This
 * suite's shared `test/setup.ts` reaches `test/helpers/environment.ts`, which
 * derives the repository root with
 * `fileURLToPath(new URL('../../../../', import.meta.url))` — and that throws
 * `The URL must be of scheme file` before any test in the file runs. Pointing
 * jsdom at a `file:` URL instead fails differently: a `file:` origin is opaque,
 * and jsdom refuses to provide `localStorage` for one.
 *
 * Building the window here keeps the environment `node`, so the shared setup
 * file loads exactly as it does for every other file in the suite. Switching to
 * `@vitest-environment jsdom` would need a one-line change in
 * `test/helpers/environment.ts` to derive its paths without `import.meta.url`.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

/**
 * Globals that Node also defines but that must come from jsdom, because a DOM
 * node will only accept the ones minted by its own window.
 *
 * `FormData` is the one that matters most here: Node's own `FormData` cannot be
 * constructed from a jsdom `<form>`, and reading the submission is most of what
 * these tests assert. Everything else is copied only where Node has no
 * equivalent, so Node's timers, promises and console — which vitest and React's
 * scheduler rely on — are left alone.
 */
const MUST_COME_FROM_JSDOM = [
  'Event',
  'EventTarget',
  'CustomEvent',
  'FormData',
  'DOMException',
  'navigator',
] as const;

for (const property of Object.getOwnPropertyNames(dom.window)) {
  const overwrite = (MUST_COME_FROM_JSDOM as readonly string[]).includes(
    property,
  );

  if (!overwrite && property in globalThis) {
    continue;
  }

  Object.defineProperty(globalThis, property, {
    configurable: true,
    writable: true,
    value: dom.window[property as keyof typeof dom.window],
  });
}

/**
 * jsdom implements no layout, so it ships no `ResizeObserver`, and Radix's
 * checkbox measures itself through one. Without this the editor throws on
 * mount.
 *
 * A stub that never reports is correct rather than merely convenient: every
 * size jsdom could report is zero, so a "real" implementation would feed Radix
 * fabricated geometry. Nothing asserted in this suite depends on a measurement
 * — the questions are which controls exist and what they submit — so an
 * observer that stays silent removes the crash without inventing an answer.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

declare global {
  // React's `act` refuses to run unless the environment opts in.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
