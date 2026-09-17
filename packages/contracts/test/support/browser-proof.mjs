/**
 * Browser-like execution proof for a built entry point.
 *
 * Usage: node browser-proof.mjs <absolute path to a built .js entry>
 *
 * Two things are removed before the entry is imported:
 *
 *  1. Node builtin resolution. A synchronous `registerHooks` resolve hook
 *     throws for any `node:` specifier and for any bare specifier that resolves
 *     to a builtin, so a single stray `import { readFile } from "node:fs"`
 *     anywhere in the graph fails the run instead of quietly working because
 *     the test happens to be on Node.
 *  2. Node-only globals. `process`, `Buffer`, `setImmediate` and friends are
 *     deleted, so code that reaches for one gets the same ReferenceError a
 *     browser would give it.
 *
 * The entry is then actually exercised — schema parsing, WebCrypto signing and
 * verification, and NDJSON parsing — because importing a module proves only
 * that its top level is portable, not its behavior. The result is printed as
 * one JSON line on stdout.
 */
/*
 * This file is a standalone Node script, not part of the linted TypeScript
 * program, so `no-undef` has no type information to work from and flags both
 * the Node globals it legitimately uses before deleting them and the web
 * globals it exercises afterwards. Both are the point of the file.
 */
/* eslint-disable no-undef */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const entryPath = process.argv[2];
if (entryPath === undefined) {
  console.error('usage: browser-proof.mjs <built entry>');
  process.exit(2);
}
const entry = pathToFileURL(entryPath).href;
const secret = 'synthetic-test-secret';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('node:')) {
      throw new Error(`Node builtin imported: ${specifier}`);
    }
    const resolved = next(specifier, context);
    if (resolved.url.startsWith('node:')) {
      throw new Error(`bare specifier resolved to a Node builtin: ${specifier}`);
    }
    return resolved;
  },
});

const removedGlobals = [
  'process',
  'Buffer',
  'setImmediate',
  'clearImmediate',
  'require',
  'module',
  'exports',
  'global',
  '__dirname',
  '__filename',
];
for (const name of removedGlobals) delete globalThis[name];

const report = (value) => {
  // `process` is gone by now, so write through the handle the runtime keeps.
  console.log(JSON.stringify(value));
};

try {
  const contracts = await import(entry);

  const config = contracts.SessionConfig.parse({
    provider: 'openai-gpt-live',
    instructions: 'Speak clearly and delegate when help is needed.',
    handler: {
      type: 'remote',
      url: 'https://handler.example.com/delegations',
      auth: { type: 'hmac-sha256', secret },
    },
  });

  const body = '{"contractVersion":"1","sessionId":"s","delegationId":"d"}';
  const header = await contracts.signHandlerRequest(secret, body);
  const verified = await contracts.verifyHandlerSignature(secret, header, body);
  const tampered = await contracts.verifyHandlerSignature(secret, header, `${body} `);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('{"kind":"commentary","content":"€ ok"}\n{"kind":"done"}\n'),
      );
      controller.close();
    },
  });
  const items = [];
  for await (const item of contracts.parseNdjson(stream, (json) =>
    contracts.HandlerResult.parse(json),
  )) {
    items.push(item);
  }

  const metadata = contracts.checkHandlerRequestMetadata(
    [
      ['duplexd-contract-version', contracts.CONTRACT_VERSION],
      ['duplexd-session-id', 's'],
    ],
    { contractVersion: contracts.CONTRACT_VERSION, sessionId: 's' },
  );

  report({
    ok: true,
    removedGlobals: removedGlobals.filter((name) => globalThis[name] !== undefined),
    handlerTimeoutMs: config.handlerTimeoutMs,
    signatureShape: /^t=\d+,v1=[0-9a-f]{64}$/.test(header),
    verified: verified.ok,
    tamperedCode: tampered.ok ? null : tampered.code,
    items,
    written: contracts.writeNdjson({ kind: 'done' }),
    metadataOk: metadata.ok,
    maxNdjsonLineBytes: contracts.MAX_NDJSON_LINE_BYTES,
  });
} catch (error) {
  report({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
