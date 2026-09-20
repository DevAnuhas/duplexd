import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  assertSafePreviewDatabase,
  previewBuildPlan,
} from '../scripts/vercel-build.ts';
import { productionContextDecision } from '../scripts/production-context.ts';
import {
  deploymentUrlFromOutput,
  runProductionDeployment,
} from '../scripts/production-deploy.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('preview migration gate', () => {
  const base = {
    VERCEL_ENV: 'preview',
    DATABASE_URL: 'postgres://user:pass@ep-synthetic-pooler.example/db',
    DATABASE_URL_UNPOOLED: 'postgres://user:pass@ep-synthetic.example/db',
    NEON_PRODUCTION_BRANCH_ID: 'br-production',
    VERCEL_GIT_COMMIT_REF: 'feat/vercel-hosting',
  };

  it.each([
    'DATABASE_URL',
    'DATABASE_URL_UNPOOLED',
    'NEON_PRODUCTION_BRANCH_ID',
    'VERCEL_GIT_COMMIT_REF',
  ])(
    'refuses a preview before connecting when %s is absent or blank',
    (name) => {
      let attemptedConnection = false;
      const env = { ...base, [name]: '   ' };
      expect(() => {
        const plan = previewBuildPlan(env);
        attemptedConnection = plan.kind === 'migrate_then_build';
      }).toThrow(new RegExp(name));
      expect(attemptedConnection).toBe(false);
    },
  );

  it('refuses pooled and unpooled URLs for different endpoints', () => {
    expect(() =>
      previewBuildPlan({
        ...base,
        DATABASE_URL_UNPOOLED: 'postgres://user:pass@ep-other.example/db',
      }),
    ).toThrow(/different Neon endpoints/);
  });

  it('refuses main even when Vercel labels the build as preview', () => {
    expect(() =>
      previewBuildPlan({ ...base, VERCEL_GIT_COMMIT_REF: 'main' }),
    ).toThrow(/VERCEL_GIT_COMMIT_REF is main/);
  });

  it('keeps production builds database-free', () => {
    expect(previewBuildPlan({ VERCEL_ENV: 'production' })).toStrictEqual({
      kind: 'build_only',
    });
  });
});

const hasNeonGateEnvironment =
  process.env.DATABASE_URL !== undefined &&
  process.env.DATABASE_URL_UNPOOLED !== undefined;

describe.skipIf(!hasNeonGateEnvironment)(
  'real Neon preview identity gate',
  () => {
    async function ledgerCount(): Promise<number> {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL_UNPOOLED,
        max: 1,
      });
      try {
        const result = await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
        );
        return Number(result.rows[0]?.count ?? 0);
      } finally {
        await pool.end();
      }
    }

    it('rejects the connected branch when named as production and accepts it otherwise', async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL_UNPOOLED,
        max: 1,
      });
      const result = await pool.query<{
        project_id: string | null;
        branch_id: string | null;
      }>(
        `SELECT current_setting('neon.project_id', true) AS project_id,
              current_setting('neon.branch_id', true) AS branch_id`,
      );
      await pool.end();
      const identity = result.rows[0];
      expect(identity?.project_id).toBe('autumn-frog-71299404');
      expect(identity?.branch_id).toMatch(/^br-/);

      const rejected = previewBuildPlan({
        VERCEL_ENV: 'preview',
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
        NEON_PRODUCTION_BRANCH_ID: identity!.branch_id!,
        VERCEL_GIT_COMMIT_REF: 'feat/vercel-hosting',
      });
      expect(rejected.kind).toBe('migrate_then_build');
      if (rejected.kind === 'migrate_then_build') {
        const before = await ledgerCount();
        await expect(assertSafePreviewDatabase(rejected)).rejects.toThrow(
          /production Neon branch/,
        );
        expect(await ledgerCount()).toBe(before);
      }

      const accepted = previewBuildPlan({
        VERCEL_ENV: 'preview',
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
        NEON_PRODUCTION_BRANCH_ID: 'br-not-the-connected-branch',
        VERCEL_GIT_COMMIT_REF: 'feat/vercel-hosting',
      });
      if (accepted.kind !== 'migrate_then_build')
        throw new Error('preview plan missing');
      await expect(
        assertSafePreviewDatabase(accepted),
      ).resolves.toBeUndefined();
    });
  },
);

describe('repository deployment wiring', () => {
  it('refuses preview-shaped production contexts and accepts main production', () => {
    expect(
      productionContextDecision({
        GITHUB_REF: 'refs/pull/43/merge',
        DEPLOYMENT_TARGET: 'production',
      }),
    ).toStrictEqual({ ok: false, reason: 'not_main' });
    expect(
      productionContextDecision({
        GITHUB_REF: 'refs/heads/main',
        DEPLOYMENT_TARGET: 'preview',
      }),
    ).toStrictEqual({ ok: false, reason: 'not_production_target' });
    expect(
      productionContextDecision({
        GITHUB_REF: 'refs/heads/main',
        DEPLOYMENT_TARGET: 'production',
      }),
    ).toStrictEqual({ ok: true });
  });

  it('wires the workflow to the guarded deployment orchestrator', () => {
    const workflow = readFileSync(
      `${repositoryRoot}.github/workflows/deploy-production.yml`,
      'utf8',
    );
    const contextGuard = workflow.indexOf(
      'apps/workspace/scripts/production-context.ts',
    );
    const orchestrator = workflow.indexOf(
      'apps/workspace/scripts/production-deploy.ts',
    );
    expect(contextGuard).toBeGreaterThan(-1);
    expect(orchestrator).toBeGreaterThan(contextGuard);
    expect(workflow).not.toMatch(/postgres(?:ql)?:\/\//);
    expect(workflow).not.toMatch(/Bearer [A-Za-z0-9_-]{16,}/);

    const implementation = readFileSync(
      `${repositoryRoot}apps/workspace/scripts/production-deploy.ts`,
      'utf8',
    );
    expect(implementation).toContain("'--skip-domain'");
    expect(implementation).toContain("'promote'");
    expect(implementation).toContain('applyMigrations');
    expect(implementation).not.toContain("'--token'");
    expect(implementation).toContain('delete vercelEnvironment.DATABASE_URL');
  });

  it('accepts exactly one deployment URL from the CLI output', () => {
    expect(deploymentUrlFromOutput('https://staged.example.invalid\n')).toBe(
      'https://staged.example.invalid',
    );
    expect(() => deploymentUrlFromOutput('build complete')).toThrow(
      /did not return a deployment URL/,
    );
    expect(() =>
      deploymentUrlFromOutput(
        'https://one.example.invalid https://two.example.invalid',
      ),
    ).toThrow(/did not return a deployment URL/);
  });

  it('executes deploy, migration, and promotion in that order', async () => {
    const calls: string[] = [];
    const result = await runProductionDeployment(
      {
        GITHUB_REF: 'refs/heads/main',
        DEPLOYMENT_TARGET: 'production',
      },
      {
        async deploy() {
          calls.push('deploy');
          return 'https://staged.example.invalid';
        },
        async migrate() {
          calls.push('migrate');
          return { before: 3, after: 4, applied: 1 };
        },
        async promote(url) {
          calls.push(`promote:${url}`);
        },
      },
    );

    expect(calls).toStrictEqual([
      'deploy',
      'migrate',
      'promote:https://staged.example.invalid',
    ]);
    expect(result.migration).toStrictEqual({ before: 3, after: 4, applied: 1 });
  });

  it('refuses before invoking any deployment operation', async () => {
    const calls: string[] = [];
    await expect(
      runProductionDeployment(
        {
          GITHUB_REF: 'refs/pull/43/merge',
          DEPLOYMENT_TARGET: 'production',
        },
        {
          async deploy() {
            calls.push('deploy');
            return 'https://unreachable.example.invalid';
          },
          async migrate() {
            calls.push('migrate');
            return { before: 0, after: 0, applied: 0 };
          },
          async promote() {
            calls.push('promote');
          },
        },
      ),
    ).rejects.toThrow(/context refused: not_main/);
    expect(calls).toStrictEqual([]);
  });

  it('reruns through promotion after a measured migration no-op', async () => {
    let ledger = 0;
    let promotionAttempts = 0;
    const calls: string[] = [];
    const environment = {
      GITHUB_REF: 'refs/heads/main',
      DEPLOYMENT_TARGET: 'production',
    };
    const operations = {
      async deploy() {
        calls.push('deploy');
        return `https://staged-${promotionAttempts}.example.invalid`;
      },
      async migrate() {
        calls.push('migrate');
        const before = ledger;
        if (ledger === 0) ledger = 1;
        return { before, after: ledger, applied: ledger - before };
      },
      async promote() {
        calls.push('promote');
        promotionAttempts += 1;
        if (promotionAttempts === 1) {
          throw new Error('synthetic promotion failure');
        }
      },
    };

    await expect(
      runProductionDeployment(environment, operations),
    ).rejects.toThrow('synthetic promotion failure');
    const recovery = await runProductionDeployment(environment, operations);

    expect(recovery.migration).toStrictEqual({
      before: 1,
      after: 1,
      applied: 0,
    });
    expect(promotionAttempts).toBe(2);
    expect(calls).toStrictEqual([
      'deploy',
      'migrate',
      'promote',
      'deploy',
      'migrate',
      'promote',
    ]);
  });

  it('disables automatic main deploys so they cannot bypass the staged workflow', () => {
    const config = JSON.parse(
      readFileSync(`${repositoryRoot}apps/workspace/vercel.json`, 'utf8'),
    ) as { git: { deploymentEnabled: { main: boolean } } };
    expect(config.git.deploymentEnabled.main).toBe(false);
  });
});
