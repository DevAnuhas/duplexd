# Build and run the workspace app as a Node server.
#
# No stage takes DATABASE_URL, BETTER_AUTH_SECRET or ASSISTANT_SECRET_KEY. The
# app reads them at server start and first use, never at module import, so the
# image builds with no database reachable from the builder. A build that needed
# the database would make every future deploy depend on it.

FROM node:24.21.0-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/workspace/package.json ./apps/workspace/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/workspace/node_modules ./apps/workspace/node_modules
COPY . .
RUN pnpm --filter workspace build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# `output: 'standalone'` emits a server plus only the modules it actually uses.
COPY --from=build /repo/apps/workspace/.next/standalone ./
COPY --from=build /repo/apps/workspace/.next/static ./apps/workspace/.next/static

# Migrations are applied by the Fly release command, not here: a container that
# migrates on boot races every other container in the same deploy.
#
# The release command runs inside this image, which is Next's standalone output
# — no pnpm workspace, no src/, and only the modules the app itself traced. So
# `pnpm --filter workspace db:migrate` cannot work here, and neither can the
# TypeScript entry point it names. `migrate.mjs` is a single bundled file with
# its dependencies inlined, and `drizzle/` is the SQL it applies.
COPY --from=build /repo/apps/workspace/drizzle ./drizzle
COPY --from=build /repo/apps/workspace/dist/migrate.mjs ./migrate.mjs

EXPOSE 3000
CMD ["node", "apps/workspace/server.js"]
