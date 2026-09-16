import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { contractsScaffold } from '@duplexd/contracts';
import { coreScaffold } from '@duplexd/core';

const require = createRequire(import.meta.url);

describe('@duplexd/core scaffold', () => {
  it('exports the core scaffold value', () => {
    expect(coreScaffold).toBe('core:contracts-ready');
  });

  it('carries the value it received through @duplexd/contracts', () => {
    // Load-bearing cross-package assertion (contract 13c): the expected value
    // is derived from the contracts import, not restated as a literal, so a
    // broken contracts->core resolution fails here rather than silently
    // passing.
    expect(coreScaffold).toBe(`core:${contractsScaffold}`);
  });

  it('resolves both packages through their published exports maps to dist', () => {
    expect(require.resolve('@duplexd/core')).toMatch(
      /[/\\]packages[/\\]core[/\\]dist[/\\]index\.js$/,
    );
    expect(require.resolve('@duplexd/contracts')).toMatch(
      /[/\\]packages[/\\]contracts[/\\]dist[/\\]index\.js$/,
    );
  });
});
