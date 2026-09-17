import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  HandlerRequestLoose,
  checkHandlerRequestMetadata,
  verifyHandlerSignature,
} from '../index.js';
import { fixturePath } from './scenarios.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface ReferenceHandlerDependencies {
  checkMetadata: typeof checkHandlerRequestMetadata;
}

export interface RunningHandler {
  url: string;
  close(): Promise<void>;
}

function problem(
  response: ServerResponse,
  status: number,
  code: string,
  detail?: string,
): void {
  response.writeHead(status, { 'content-type': 'application/problem+json' });
  response.end(
    JSON.stringify({ code, ...(detail === undefined ? {} : { detail }) }),
  );
}

function rawHeaderPairs(
  request: IncomingMessage,
): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    pairs.push([
      request.rawHeaders[index] ?? '',
      request.rawHeaders[index + 1] ?? '',
    ]);
  }
  return pairs;
}

function singleHeader(request: IncomingMessage, name: string): string | null {
  const values = rawHeaderPairs(request)
    .filter(([header]) => header.toLowerCase() === name)
    .map(([, value]) => value);
  return values.length === 1 ? (values[0] ?? null) : null;
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk,
    );
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function validateRequest(
  request: IncomingMessage,
  response: ServerResponse,
  rawBody: Uint8Array,
  secret: string,
  dependencies: ReferenceHandlerDependencies,
): Promise<ReturnType<typeof HandlerRequestLoose.parse> | null> {
  const signature = await verifyHandlerSignature(
    secret,
    singleHeader(request, 'duplexd-signature'),
    rawBody,
  );
  if (!signature.ok) {
    problem(response, 401, signature.code);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(rawBody));
  } catch {
    problem(response, 400, 'malformed_body');
    return null;
  }

  const fields =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { contractVersion?: unknown; sessionId?: unknown })
      : {};
  const metadata = dependencies.checkMetadata(rawHeaderPairs(request), {
    contractVersion:
      typeof fields.contractVersion === 'string' ? fields.contractVersion : '',
    sessionId: typeof fields.sessionId === 'string' ? fields.sessionId : '',
  });
  if (!metadata.ok) {
    problem(response, metadata.status, metadata.code, metadata.detail);
    return null;
  }

  const result = HandlerRequestLoose.safeParse(parsed);
  if (!result.success) {
    problem(response, 400, 'invalid_request');
    return null;
  }
  return result.data;
}

function streamItems(
  body: ReturnType<typeof HandlerRequestLoose.parse>,
): Promise<string[]> {
  const text = body.transcript
    .map((fragment) => fragment.text)
    .join(' ')
    .toLowerCase();
  const fixture =
    text.includes('order') || body.transcript.length === 0
      ? 'order-status.ndjson'
      : 'booking.ndjson';
  return readFile(fixturePath('results', fixture), 'utf8').then(
    (content) => content.match(/[^\n]*\n|[^\n]+$/g) ?? [],
  );
}

function sampleDelay(
  body: ReturnType<typeof HandlerRequestLoose.parse>,
): number {
  const sample =
    body.consumerContext !== null &&
    typeof body.consumerContext === 'object' &&
    !Array.isArray(body.consumerContext)
      ? body.consumerContext.sample
      : undefined;
  return sample !== null &&
    typeof sample === 'object' &&
    !Array.isArray(sample) &&
    typeof sample.delayMs === 'number'
    ? sample.delayMs
    : 0;
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  buffered: boolean,
  dependencies: ReferenceHandlerDependencies,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/delegations') {
    problem(response, 404, 'not_found');
    return;
  }
  const rawBody = await readBody(request);
  const body = await validateRequest(
    request,
    response,
    rawBody,
    secret,
    dependencies,
  );
  if (body === null) return;

  const delay = sampleDelay(body);
  const items = await streamItems(body);
  if (buffered) {
    if (delay > 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end(items.join(''));
    return;
  }

  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  response.flushHeaders();
  if (delay > 0) {
    response.write(' \n');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  for (const item of items) response.write(item);
  response.end();
}

async function startHandler(
  secret: string,
  buffered: boolean,
  dependencies: ReferenceHandlerDependencies,
): Promise<RunningHandler> {
  const server: Server = createServer((request, response) => {
    void serve(request, response, secret, buffered, dependencies).catch(() => {
      if (!response.headersSent) problem(response, 500, 'internal_error');
      else response.destroy();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Handler did not bind TCP');
  return {
    url: `http://127.0.0.1:${address.port}/delegations`,
    close: () =>
      new Promise<void>((resolveClose, reject) =>
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        ),
      ),
  };
}

const defaultDependencies: ReferenceHandlerDependencies = {
  checkMetadata: checkHandlerRequestMetadata,
};

export function startReferenceHandler(
  secret: string,
  dependencies: ReferenceHandlerDependencies = defaultDependencies,
): Promise<RunningHandler> {
  return startHandler(secret, false, dependencies);
}

export function startBufferingHandler(
  secret: string,
  dependencies: ReferenceHandlerDependencies = defaultDependencies,
): Promise<RunningHandler> {
  return startHandler(secret, true, dependencies);
}
