import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { contractsScaffold } from '@duplexd/contracts';

const require = createRequire(import.meta.url);

describe('@duplexd/contracts scaffold', () => {
  it('exports the contracts scaffold value', () => {
    expect(contractsScaffold).toBe('contracts-ready');
  });

  it('resolves through the published exports map to dist', () => {
    expect(require.resolve('@duplexd/contracts')).toMatch(
      /[/\\]packages[/\\]contracts[/\\]dist[/\\]index\.js$/,
    );
  });
});
