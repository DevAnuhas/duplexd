import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { handlerNodeScaffold } from 'handler-node';

const require = createRequire(import.meta.url);

describe('handler-node scaffold', () => {
  it('exports the handler-node scaffold value', () => {
    expect(handlerNodeScaffold).toBe('handler-node-ready');
  });

  it('resolves through the published exports map to dist', () => {
    expect(require.resolve('handler-node')).toMatch(
      /[/\\]examples[/\\]handler-node[/\\]dist[/\\]index\.js$/,
    );
  });
});
