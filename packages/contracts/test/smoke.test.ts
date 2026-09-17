import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  CONTRACT_VERSION,
  HandlerResult,
  SessionConfig,
  parseNdjson,
  signHandlerRequest,
  verifyHandlerSignature,
  writeNdjson,
} from '@duplexd/contracts';

import { SYNTHETIC_TEST_SECRET } from './support/fixtures.js';

const require = createRequire(import.meta.url);

/**
 * The T01 scaffold smoke test, re-pointed at the real T02 surface.
 *
 * T01 asserted a placeholder `contractsScaffold` value and a `dist/index.js`
 * resolution. Both are gone: the package now emits from `dist/src/` because
 * `tsc` also compiles `scripts/`, and the scaffold constant was replaced by the
 * contract itself. What survives unchanged is the point of the test — that the
 * published exports map resolves to built output and that the built output
 * actually works.
 */
describe('@duplexd/contracts smoke', () => {
  it('resolves through the published exports map to built output', () => {
    expect(require.resolve('@duplexd/contracts')).toMatch(
      /[/\\]packages[/\\]contracts[/\\]dist[/\\]src[/\\]index\.js$/,
    );
    expect(require.resolve('@duplexd/contracts/conformance')).toMatch(
      /[/\\]packages[/\\]contracts[/\\]dist[/\\]src[/\\]conformance[/\\]index\.js$/,
    );
  });

  it('exports the contract version the rest of the workspace builds on', () => {
    expect(CONTRACT_VERSION).toBe('1');
  });

  it('parses a session config through the built entry', () => {
    const config = SessionConfig.parse({
      provider: 'openai-gpt-live',
      instructions: 'Speak clearly and delegate when help is needed.',
      handler: {
        type: 'remote',
        url: 'https://handler.example.com/delegations',
        auth: { type: 'hmac-sha256', secret: SYNTHETIC_TEST_SECRET },
      },
    });
    expect(config.handlerTimeoutMs).toBe(30_000);
  });

  it('signs and verifies through the built entry', async () => {
    const body = '{"contractVersion":"1"}';
    const header = await signHandlerRequest(SYNTHETIC_TEST_SECRET, body);
    expect(await verifyHandlerSignature(SYNTHETIC_TEST_SECRET, header, body)).toEqual({ ok: true });
  });

  it('round-trips a handler result through the built NDJSON helpers', async () => {
    const text = writeNdjson({ kind: 'done' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    const items: unknown[] = [];
    for await (const item of parseNdjson(stream, (json) => HandlerResult.parse(json))) {
      items.push(item);
    }
    expect(items).toEqual([{ kind: 'done' }]);
  });
});
