import { defineConfig } from 'drizzle-kit';

/**
 * `DATABASE_URL` is read here rather than through `src/db/env.ts` because
 * drizzle-kit runs this file as a CLI config, outside the app's module graph.
 * The fail-closed behaviour is the same: an unset or empty value must error
 * rather than fall through to a client default that would connect to whatever
 * PostgreSQL happens to be listening locally.
 */
const url = process.env.DATABASE_URL;

if (url === undefined || url.trim() === '') {
  throw new Error(
    'DATABASE_URL is unset or empty. drizzle-kit will not be given an empty ' +
      'connection string, because an empty value connects to a local database ' +
      'instead of failing.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
