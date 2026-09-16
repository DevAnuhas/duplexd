import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { webrtcTransportScaffold } from '@duplexd/transport-webrtc';

const require = createRequire(import.meta.url);

describe('@duplexd/transport-webrtc scaffold', () => {
  it('exports the webrtc transport scaffold value', () => {
    expect(webrtcTransportScaffold).toBe('webrtc-transport-ready');
  });

  it('resolves through the published exports map to dist', () => {
    expect(require.resolve('@duplexd/transport-webrtc')).toMatch(
      /[/\\]packages[/\\]transports[/\\]webrtc[/\\]dist[/\\]index\.js$/,
    );
  });
});
