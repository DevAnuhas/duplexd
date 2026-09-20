import { pathToFileURL } from 'node:url';

type Environment = Readonly<Record<string, string | undefined>>;

export type ProductionContextDecision =
  { ok: true } | { ok: false; reason: 'not_main' | 'not_production_target' };

/** Behavioural guard called before the production workflow deploys or connects. */
export function productionContextDecision(
  env: Environment,
): ProductionContextDecision {
  if (env.GITHUB_REF !== 'refs/heads/main') {
    return { ok: false, reason: 'not_main' };
  }
  if (env.DEPLOYMENT_TARGET !== 'production') {
    return { ok: false, reason: 'not_production_target' };
  }
  return { ok: true };
}

function main(): void {
  const decision = productionContextDecision(process.env);
  if (!decision.ok) {
    throw new Error(
      `[production-deploy] context refused: ${decision.reason}; no deployment or database connection attempted.`,
    );
  }
  console.log('[production-deploy] context accepted: main -> production.');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'context refused');
    process.exitCode = 1;
  }
}
