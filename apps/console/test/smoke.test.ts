import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { consoleScaffold } from '@duplexd/console';

const require = createRequire(import.meta.url);

describe('@duplexd/console scaffold', () => {
  it('exports the console scaffold value', () => {
    expect(consoleScaffold).toBe('console-ready');
  });

  it('resolves through the published exports map to dist', () => {
    expect(require.resolve('@duplexd/console')).toMatch(
      /[/\\]apps[/\\]console[/\\]dist[/\\]index\.js$/,
    );
  });

  it('runs in the Node environment, with no DOM available in T01', () => {
    // Contract 27: the console workspace ships no UI behavior yet, so its
    // tests must stay on Vitest's Node environment rather than jsdom.
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof process.versions.node).toBe('string');
  });
});
