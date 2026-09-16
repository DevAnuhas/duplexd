import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';

import { HandlerResult, parseNdjson, signHandlerRequest } from '../index.js';
import {
  CONFORMANCE_SCENARIOS,
  type ConformanceScenarioName,
  fixturePath,
  loadScenario,
} from './scenarios.js';

export interface ScenarioResult {
  name: ConformanceScenarioName;
  passed: boolean;
  reason?: string;
}

export interface ConformanceReport {
  passed: boolean;
  scenarios: ScenarioResult[];
}

export interface ConformanceOptions {
  url: string;
  secret: string;
  scenarios?: readonly ConformanceScenarioName[];
  fetch?: typeof globalThis.fetch;
}

interface PreparedRequest {
  body: string;
  headers: Record<string, string>;
}

async function requestFixture(name: string): Promise<Record<string, unknown>> {
  const fixture = JSON.parse(
    await readFile(fixturePath('requests', `${name}.json`), 'utf8'),
  ) as { request: Record<string, unknown> };
  return structuredClone(fixture.request);
}

async function prepare(
  requestName: string,
  secret: string,
  scenario: ConformanceScenarioName,
): Promise<PreparedRequest> {
  const request = await requestFixture(requestName);
  if (scenario === 'unsupported-version') request.contractVersion = '0';
  const body = JSON.stringify(request);
  const signingSecret =
    scenario === 'bad-signature' ? `${secret}-wrong` : secret;
  const now =
    scenario === 'stale-timestamp'
      ? () => Date.now() - 10 * 60 * 1_000
      : Date.now;
  const signature = await signHandlerRequest(signingSecret, body, now);
  const headers = {
    'content-type': 'application/json',
    'duplexd-signature': signature,
    'duplexd-contract-version': String(request.contractVersion),
    'duplexd-session-id': String(request.sessionId),
  };
  if (scenario === 'metadata-mismatch-session') {
    headers['duplexd-session-id'] = 'another-session';
  }
  if (scenario === 'metadata-mismatch-version') {
    headers['duplexd-contract-version'] = '0';
  }
  return { body, headers };
}

async function commentary(response: Response): Promise<string[]> {
  if (response.headers.get('content-type') !== 'application/x-ndjson') {
    throw new Error('successful response must use application/x-ndjson');
  }
  if (response.body === null) throw new Error('response body is missing');
  const items: Array<ReturnType<typeof HandlerResult.parse>> = [];
  for await (const item of parseNdjson(response.body, (json) =>
    HandlerResult.parse(json),
  )) {
    items.push(item);
  }
  if (items.at(-1)?.kind !== 'done') throw new Error('last result is not done');
  return items
    .filter(
      (item): item is Extract<(typeof items)[number], { kind: 'commentary' }> =>
        item.kind === 'commentary',
    )
    .map((item) => item.content);
}

async function duplicateHeaderRequest(
  url: string,
  prepared: PreparedRequest,
): Promise<{ status: number; code?: string }> {
  const target = new URL(url);
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(
      target,
      {
        method: 'POST',
        headers: {
          ...prepared.headers,
          'content-length': String(
            new TextEncoder().encode(prepared.body).byteLength,
          ),
          'duplexd-session-id': [
            prepared.headers['duplexd-session-id'] ?? '',
            prepared.headers['duplexd-session-id'] ?? '',
          ],
        },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        response.on('end', () => {
          const text = new TextDecoder().decode(
            chunks.length === 1
              ? chunks[0]
              : Uint8Array.from(chunks.flatMap(Array.from)),
          );
          const parsed =
            text.length === 0 ? {} : (JSON.parse(text) as { code?: string });
          resolveRequest({
            status: response.statusCode ?? 0,
            code: parsed.code,
          });
        });
      },
    );
    request.once('error', reject);
    request.end(prepared.body);
  });
}

async function runOne(
  url: string,
  secret: string,
  name: ConformanceScenarioName,
  fetcher: typeof globalThis.fetch,
): Promise<void> {
  const fixture = await loadScenario(name);
  const prepared = await prepare(fixture.request, secret, name);

  if (name === 'metadata-duplicate-header') {
    const response = await duplicateHeaderRequest(url, prepared);
    if (response.status !== 400 || response.code !== 'metadata_mismatch') {
      throw new Error(
        `expected 400 metadata_mismatch, got ${response.status} ${response.code}`,
      );
    }
    return;
  }

  if (name === 'replayed-request' || name === 'concurrent-replay') {
    const send = async () => {
      const response = await fetcher(url, {
        method: 'POST',
        headers: prepared.headers,
        body: prepared.body,
        redirect: 'error',
      });
      if (response.status !== 200)
        throw new Error(`expected 200, got ${response.status}`);
      return commentary(response);
    };
    const [first, second] =
      name === 'concurrent-replay'
        ? await Promise.all([send(), send()])
        : [await send(), await send()];
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error('replayed commentary differs');
    }
    return;
  }

  if (name === 'keepalive-under-delay') {
    const controller = new AbortController();
    const started = performance.now();
    const deadline = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: prepared.headers,
        body: prepared.body,
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200 || response.body === null) {
        throw new Error(`expected streaming 200, got ${response.status}`);
      }
      if (response.headers.get('content-type') !== 'application/x-ndjson') {
        throw new Error('successful response must use application/x-ndjson');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let completeLine = false;
      while (!completeLine) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error('response ended before a complete keepalive or item');
        }
        chunks.push(chunk.value);
        completeLine = chunk.value.includes(0x0a);
      }
      if (performance.now() - started >= 2_000) {
        throw new Error('complete line arrived after the 2000ms deadline');
      }
      clearTimeout(deadline);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      reader.releaseLock();
      const byteLength = chunks.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      );
      const body = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await commentary(
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      );
      return;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          'no response headers or complete line before the 2000ms deadline',
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  const response = await fetcher(url, {
    method: 'POST',
    headers: prepared.headers,
    body: prepared.body,
    redirect: 'error',
  });
  if (fixture.expectation === 'problem') {
    const problem = (await response.json()) as { code?: string };
    if (response.status !== fixture.status || problem.code !== fixture.code) {
      throw new Error(
        `expected ${fixture.status} ${fixture.code}, got ${response.status} ${problem.code}`,
      );
    }
    return;
  }
  if (response.status !== 200)
    throw new Error(`expected 200, got ${response.status}`);
  await commentary(response);
}

export async function runConformance(
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const selected = options.scenarios ?? CONFORMANCE_SCENARIOS;
  const unknown = selected.find(
    (name) => !CONFORMANCE_SCENARIOS.includes(name as ConformanceScenarioName),
  );
  if (unknown !== undefined)
    throw new Error(`Unknown conformance scenario: ${unknown}`);
  const results: ScenarioResult[] = [];
  for (const name of selected) {
    try {
      await runOne(
        options.url,
        options.secret,
        name,
        options.fetch ?? globalThis.fetch,
      );
      results.push({ name, passed: true });
    } catch (error) {
      results.push({
        name,
        passed: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    passed: results.every((result) => result.passed),
    scenarios: results,
  };
}
