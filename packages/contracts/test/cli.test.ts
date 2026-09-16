import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type RunningHandler,
  startBufferingHandler,
  startReferenceHandler,
} from '@duplexd/contracts/conformance';

import { distRoot, packageRoot, SYNTHETIC_TEST_SECRET } from './support/fixtures.js';

const execFileAsync = promisify(execFile);
const secret = SYNTHETIC_TEST_SECRET;
const repoRoot = resolve(packageRoot, '..', '..');

const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
};

/**
 * The installed built bin, resolved the way a consumer would reach it.
 *
 * Preference order is the real `node_modules/.bin` shim when the workspace has
 * one, then the path the manifest's `bin` field points at. Either way this is
 * the built executable — no source runner and no test-only import stands in
 * for it.
 */
const binFromManifest = resolve(packageRoot, manifest.bin['duplexd-conformance'] ?? '');
const binShim = [
  resolve(packageRoot, 'node_modules/.bin/duplexd-conformance'),
  resolve(repoRoot, 'node_modules/.bin/duplexd-conformance'),
].find((candidate) => existsSync(candidate));

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliRun> {
  const target = binShim ?? binFromManifest;
  // A shim is an executable in its own right; the manifest path is a Node ESM
  // module, so it runs under the same interpreter the shebang names.
  const [command, commandArgs] =
    binShim === undefined
      ? [process.execPath, [binFromManifest, ...args]]
      : [target, args];
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      status: failure.code ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

let reference: RunningHandler;
let buffering: RunningHandler;

beforeAll(async () => {
  reference = await startReferenceHandler(secret);
  buffering = await startBufferingHandler(secret);
});
afterAll(async () => {
  await Promise.all([reference.close(), buffering.close()]);
});

describe('the duplexd-conformance bin', () => {
  it('is declared and resolves to built output', () => {
    expect(manifest.bin['duplexd-conformance']).toBe('./dist/src/conformance/cli.js');
    expect(existsSync(binFromManifest)).toBe(true);
    expect(realpathSync(binFromManifest).startsWith(realpathSync(distRoot))).toBe(true);
  });

  it('carries a shebang so an installed shim can execute it', () => {
    expect(readFileSync(binFromManifest, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });
});

describe('duplexd-conformance against the reference handler', () => {
  it('exits 0 for the literal full-suite command', async () => {
    const run = await runCli(['--url', reference.url, '--secret', secret]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);

    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(14);
    for (const line of lines) expect(line.startsWith('PASS ')).toBe(true);
    for (const name of ['booking-request', 'replayed-request', 'keepalive-under-delay']) {
      expect(run.stdout).toContain(`PASS ${name}`);
    }
  }, 60_000);

  it('runs only the selected scenario', async () => {
    const run = await runCli([
      '--url',
      reference.url,
      '--secret',
      secret,
      '--scenario',
      'booking-request',
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('PASS booking-request');
  }, 30_000);

  it('never prints the secret', async () => {
    const run = await runCli(['--url', reference.url, '--secret', secret]);
    expect(`${run.stdout}${run.stderr}`).not.toContain(secret);
  }, 60_000);
});

describe('duplexd-conformance against the buffering handler', () => {
  it('exits nonzero on the delayed keepalive, within a bounded time', async () => {
    // Timed from before dispatch — process start, connection, and the wait for
    // response headers all count against the deadline.
    const started = performance.now();
    const run = await runCli([
      '--url',
      buffering.url,
      '--secret',
      secret,
      '--scenario',
      'keepalive-under-delay',
    ]);
    const elapsed = performance.now() - started;

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL keepalive-under-delay');
    expect(run.stdout).toContain('2000ms deadline');
    expect(`${run.stdout}${run.stderr}`).not.toContain(secret);
    // Bounded: it gives up at the deadline rather than waiting out the hold.
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  it('exits nonzero for the full suite but still passes the undelayed scenarios', async () => {
    const run = await runCli(['--url', buffering.url, '--secret', secret]);
    expect(run.status).not.toBe(0);

    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(14);
    expect(lines.filter((line) => line.startsWith('FAIL '))).toHaveLength(1);
    expect(run.stdout).toContain('FAIL keepalive-under-delay');
    expect(run.stdout).toContain('PASS booking-request');
  }, 60_000);
});

describe('duplexd-conformance argument handling', () => {
  it('exits nonzero with usage when a required flag is missing', async () => {
    for (const args of [
      [],
      ['--url', reference.url],
      ['--secret', secret],
    ]) {
      const run = await runCli(args);
      expect(run.status, `args ${JSON.stringify(args)}`).not.toBe(0);
      expect(run.stderr).toContain('Usage: duplexd-conformance');
      expect(run.stdout).toBe('');
    }
  }, 30_000);

  it('exits nonzero for an unknown scenario without contacting the handler', async () => {
    const run = await runCli([
      '--url',
      reference.url,
      '--secret',
      secret,
      '--scenario',
      'not-a-scenario',
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not-a-scenario');
    expect(run.stdout).toBe('');
  }, 30_000);

  it('reports a config error rather than hanging on an unreachable URL', async () => {
    const dead = await startReferenceHandler(secret);
    const url = dead.url;
    await dead.close();

    const run = await runCli(['--url', url, '--secret', secret, '--scenario', 'booking-request']);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL booking-request');
    expect(`${run.stdout}${run.stderr}`).not.toContain(secret);
  }, 30_000);
});
