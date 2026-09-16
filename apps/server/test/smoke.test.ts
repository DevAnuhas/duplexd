import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { serverScaffold } from '@duplexd/server';

const require = createRequire(import.meta.url);

describe('@duplexd/server scaffold', () => {
  it('exports the server scaffold value', () => {
    expect(serverScaffold).toBe('server-ready');
  });

  it('resolves through the published exports map to dist', () => {
    expect(require.resolve('@duplexd/server')).toMatch(
      /[/\\]apps[/\\]server[/\\]dist[/\\]index\.js$/,
    );
  });
});
