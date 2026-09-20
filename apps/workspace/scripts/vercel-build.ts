import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { applyMigrations } from '../src/db/migrate.ts';

const NEON_PROJECT_ID = 'autumn-frog-71299404';

export type PreviewBuildPlan =
  | { kind: 'build_only' }
  | {
      kind: 'migrate_then_build';
      pooledUrl: string;
      unpooledUrl: string;
      productionBranchId: string;
      gitCommitRef: string;
    };

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`[preview-migration] ${name} is unset or empty; refusing.`);
  }
  return value.trim();
}

function normalizedEndpoint(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `[preview-migration] ${name} is not a valid URL; refusing.`,
    );
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`[preview-migration] ${name} is not PostgreSQL; refusing.`);
  }
  return url.hostname.replace(/-pooler(?=\.)/, '');
}

/** Pure, fail-closed classification used by both the script and its gate. */
export function previewBuildPlan(env: Environment): PreviewBuildPlan {
  if (env.VERCEL_ENV !== 'preview') return { kind: 'build_only' };

  const pooledUrl = required(env, 'DATABASE_URL');
  const unpooledUrl = required(env, 'DATABASE_URL_UNPOOLED');
  const productionBranchId = required(env, 'NEON_PRODUCTION_BRANCH_ID');
  const gitCommitRef = required(env, 'VERCEL_GIT_COMMIT_REF');
  if (gitCommitRef === 'main') {
    throw new Error(
      '[preview-migration] VERCEL_GIT_COMMIT_REF is main in a preview build; refusing.',
    );
  }
  if (
    normalizedEndpoint(pooledUrl, 'DATABASE_URL') !==
    normalizedEndpoint(unpooledUrl, 'DATABASE_URL_UNPOOLED')
  ) {
    throw new Error(
      '[preview-migration] DATABASE_URL and DATABASE_URL_UNPOOLED name different Neon endpoints; refusing.',
    );
  }

  return {
    kind: 'migrate_then_build',
    pooledUrl,
    unpooledUrl,
    productionBranchId,
    gitCommitRef,
  };
}

export type NeonIdentity = {
  project_id: string | null;
  branch_id: string | null;
};

export type PreviewDatabaseDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_neon' | 'wrong_project' | 'production_branch';
      message: string;
    };

/** Pure identity decision kept in CI; the live Neon query is a manual gate. */
export function previewDatabaseDecision(
  identity: NeonIdentity | undefined,
  productionBranchId: string,
): PreviewDatabaseDecision {
  if (identity?.project_id == null || identity.branch_id == null) {
    return {
      ok: false,
      reason: 'not_neon',
      message: '[preview-migration] target is not a Neon database; refusing.',
    };
  }
  if (identity.project_id !== NEON_PROJECT_ID) {
    return {
      ok: false,
      reason: 'wrong_project',
      message:
        '[preview-migration] target belongs to the wrong Neon project; refusing.',
    };
  }
  if (identity.branch_id === productionBranchId) {
    return {
      ok: false,
      reason: 'production_branch',
      message:
        '[preview-migration] target is the production Neon branch; refusing.',
    };
  }
  return { ok: true };
}

/** Checks the exact unpooled connection that migration will use. */
export async function assertSafePreviewDatabase(
  plan: Extract<PreviewBuildPlan, { kind: 'migrate_then_build' }>,
): Promise<void> {
  const pool = new Pool({ connectionString: plan.unpooledUrl, max: 1 });
  try {
    const result = await pool.query<NeonIdentity>(
      `SELECT current_setting('neon.project_id', true) AS project_id,
              current_setting('neon.branch_id', true) AS branch_id`,
    );
    const identity = result.rows[0];
    const decision = previewDatabaseDecision(
      identity,
      plan.productionBranchId,
    );
    if (!decision.ok) throw new Error(decision.message);
  } finally {
    await pool.end();
  }
}

function nextBuild(): void {
  const result = spawnSync('pnpm', ['exec', 'next', 'build'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `[vercel-build] next build failed with status ${result.status ?? 'unknown'}.`,
    );
  }
}

async function main(): Promise<void> {
  const plan = previewBuildPlan(process.env);
  if (plan.kind === 'migrate_then_build') {
    await assertSafePreviewDatabase(plan);
    const report = await applyMigrations(plan.unpooledUrl);
    console.log(
      `[preview-migration] applied=${report.applied} ledger_before=${report.before} ledger_after=${report.after}`,
    );
  }
  nextBuild();
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Vercel build failed',
    );
    process.exitCode = 1;
  });
}
