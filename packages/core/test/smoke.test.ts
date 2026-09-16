import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { CONTRACT_VERSION } from '@duplexd/contracts';
import { coreScaffold } from '@duplexd/core';

const require = createRequire(import.meta.url);

describe('@duplexd/core scaffold', () => {
  it('exports the core scaffold value', () => {
    expect(coreScaffold).toBe('core:contracts-v1');
  });

  it('carries the value it received through @duplexd/contracts', () => {
    // Load-bearing cross-package assertion (contract 13c): the expected value
    // is derived from the contracts import, not restated as a literal, so a
    // broken contracts->core resolution fails here rather than silently
    // passing. T01 threaded a placeholder scaffold string; T02 replaced it with
    // the real contract version, which is a stronger thing to thread.
    expect(coreScaffold).toBe(`core:contracts-v${CONTRACT_VERSION}`);
  });

  it('resolves both packages through their published exports maps to dist', () => {
    expect(require.resolve('@duplexd/core')).toMatch(
      /[/\\]packages[/\\]core[/\\]dist[/\\]index\.js$/,
    );
    // The contracts package emits under dist/src because tsc also compiles its
    // schema build scripts; the exports map is what keeps that an internal
    // detail for consumers.
    expect(require.resolve('@duplexd/contracts')).toMatch(
      /[/\\]packages[/\\]contracts[/\\]dist[/\\]src[/\\]index\.js$/,
    );
  });
});
