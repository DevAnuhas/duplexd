/**
 * Environment access for anything that talks to Postgres.
 *
 * Every getter here is called at request time, never at module import. Reading
 * these at import would make `next build` require a database and an encryption
 * key, which would in turn make every deploy depend on the database being
 * reachable from the builder.
 */

/**
 * `DATABASE_URL`, or an error naming it.
 *
 * An unset or empty value must never be passed through to a Postgres client.
 * `psql` and libpq-based clients treat an empty connection string as "use the
 * defaults" and connect to the local unix socket on port 5432 — so an empty
 * variable does not fail, it quietly talks to whatever database happens to be
 * running locally. That is how an agent in this repository nearly migrated an
 * unrelated database: a shell failed to parse a `.env` line, the variable came
 * through empty, and the client connected to localhost instead of erroring.
 *
 * The host itself is deliberately not inspected. A Neon branch is the
 * documented default and any PostgreSQL 17 or newer works; `DATABASE_URL` is a
 * connection string and nothing here special-cases what answers it.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is unset or empty. Set it to a PostgreSQL connection ' +
        'string. It is never defaulted: an empty value would connect to a ' +
        'local database instead of failing.',
    );
  }

  return url;
}

/**
 * The 32-byte key protecting assistants' webhook secrets at rest, as hex.
 *
 * Wrong length is an error rather than a silently padded or truncated key, and
 * there is no fallback to a built-in default — a default key is the same as no
 * encryption, with the added problem that it looks encrypted.
 */
export function requireEncryptionKey(): Buffer {
  const hex = process.env.ASSISTANT_SECRET_KEY;

  if (hex === undefined || hex.trim() === '') {
    throw new Error(
      'ASSISTANT_SECRET_KEY is unset or empty. It must be 32 bytes of random ' +
        'data, hex-encoded (64 characters).',
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error(
      'ASSISTANT_SECRET_KEY must be exactly 64 hex characters (32 bytes). ' +
        `Received ${hex.trim().length} characters.`,
    );
  }

  return Buffer.from(hex.trim(), 'hex');
}

/** The Better Auth signing secret, or an error naming it. */
export function requireAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;

  if (secret === undefined || secret.trim() === '') {
    throw new Error('BETTER_AUTH_SECRET is unset or empty.');
  }

  return secret;
}
