import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyMigrations, type MigrationReport } from '../src/db/migrate.ts';
import { productionContextDecision } from './production-context.ts';

type Environment = Readonly<Record<string, string | undefined>>;

export type ProductionDeploymentOperations = {
  deploy: () => Promise<string>;
  migrate: () => Promise<MigrationReport>;
  promote: (deploymentUrl: string) => Promise<void>;
};

export type ProductionDeploymentResult = {
  deploymentUrl: string;
  migration: MigrationReport;
};

/**
 * The production release transaction, expressed as one callable seam so the
 * migrate-before-promote guarantee and its recovery path can be exercised.
 */
export async function runProductionDeployment(
  env: Environment,
  operations: ProductionDeploymentOperations,
): Promise<ProductionDeploymentResult> {
  const decision = productionContextDecision(env);
  if (!decision.ok) {
    throw new Error(
      `[production-deploy] context refused: ${decision.reason}; no deployment or database connection attempted.`,
    );
  }

  const deploymentUrl = await operations.deploy();
  const migration = await operations.migrate();
  await operations.promote(deploymentUrl);
  return { deploymentUrl, migration };
}

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const vercelCli = [
  'dlx',
  '--allow-build=esbuild',
  '--use-stderr',
  'vercel@59.23.2',
] as const;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`[production-deploy] ${name} is required.`);
  }
  return value;
}

export function deploymentUrlFromOutput(output: string): string {
  const urls = output
    .split(/\s+/u)
    .filter((value) => /^https:\/\/[^\s]+$/u.test(value));
  if (urls.length !== 1) {
    throw new Error(
      '[production-deploy] Vercel did not return a deployment URL.',
    );
  }
  return urls[0]!;
}

async function command(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.pipe(process.stderr);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(`${executable} exited with status ${code ?? 'unknown'}.`),
        );
    });
  });
}

function realOperations(
  env: NodeJS.ProcessEnv,
): ProductionDeploymentOperations {
  const vercelEnvironment = { ...env };
  delete vercelEnvironment.DATABASE_URL;

  return {
    async deploy() {
      required(env, 'VERCEL_TOKEN');
      const output = await command(
        'pnpm',
        [...vercelCli, 'deploy', '--prod', '--skip-domain', '--yes'],
        vercelEnvironment,
      );
      return deploymentUrlFromOutput(output);
    },
    async migrate() {
      const report = await applyMigrations(required(env, 'DATABASE_URL'));
      console.log(
        `migrations applied=${report.applied} ledger_before=${report.before} ledger_after=${report.after}`,
      );
      return report;
    },
    async promote(deploymentUrl) {
      required(env, 'VERCEL_TOKEN');
      await command(
        'pnpm',
        [...vercelCli, 'promote', deploymentUrl, '--yes'],
        vercelEnvironment,
      );
    },
  };
}

async function main(): Promise<void> {
  const result = await runProductionDeployment(
    process.env,
    realOperations(process.env),
  );
  console.log(`[production-deploy] promoted ${result.deploymentUrl}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'deployment failed');
    process.exitCode = 1;
  });
}
