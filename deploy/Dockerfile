# syntax=docker/dockerfile:1
# Sling control plane: API, master agent, and the built web app.
# Build from the repo root: docker build -f deploy/Dockerfile .

FROM node:26-slim AS base
RUN npm install -g pnpm@12.5.1 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/runner-protocol/package.json packages/runner-protocol/
COPY packages/workflow/package.json packages/workflow/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/extension-package/package.json packages/extension-package/
COPY packages/extension-runtime/package.json packages/extension-runtime/
COPY packages/extension-cli/package.json packages/extension-cli/
COPY integrations/discord/package.json integrations/discord/
COPY integrations/email/package.json integrations/email/
COPY integrations/calendar/package.json integrations/calendar/
COPY integrations/docker/package.json integrations/docker/
COPY integrations/railway/package.json integrations/railway/
COPY integrations/telegram/package.json integrations/telegram/
COPY extensions/ntfy/package.json extensions/ntfy/
COPY extensions/fly-machines/package.json extensions/fly-machines/
COPY extensions/task-alerts/package.json extensions/task-alerts/

FROM base AS web
RUN pnpm install --frozen-lockfile --filter "@sling/web..."
COPY assets assets
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/workflow packages/workflow
COPY apps/web apps/web
RUN pnpm --filter @sling/web build

# The catalog that ships with Sling: the example extensions, bundled and
# packed. The build only needs the CLI; it bundles the SDK and zod from there.
FROM base AS extensions
RUN pnpm install --frozen-lockfile --filter "@sling/extension-cli..."
COPY tsconfig.base.json ./
COPY packages/connector-sdk packages/connector-sdk
COPY packages/extension-package packages/extension-package
COPY packages/workflow packages/workflow
COPY packages/extension-cli packages/extension-cli
COPY extensions extensions
RUN pnpm extensions:build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter "@sling/server..."

FROM node:26-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SLING_WEB_DIST=/app/web \
    SLING_INCLUDED_EXTENSIONS=/app/extensions
WORKDIR /app
# Workspace packages are symlinked into node_modules from /app/packages, so
# Node's built-in type stripping runs them from source.
COPY --from=deps /app /app
COPY packages packages
COPY integrations integrations
COPY apps/server apps/server
# Bundled workflow templates. The server reads them from the repo root.
COPY workflows workflows
# Runner install scripts, served at /install.sh and /install.ps1. Cargo.toml
# names the sling-runner version this server hands out to them.
COPY scripts/install.sh scripts/install.ps1 scripts/
COPY Cargo.toml ./
COPY --from=web /app/apps/web/dist /app/web
# Included extensions: catalog.json and the .slx files it lists.
COPY --from=extensions /app/extensions/dist /app/extensions
# extensions/*/ holds only the package.json files the install step copied in.
RUN rm -rf packages/*/src/*.test.ts packages/*/src/*.test-util.ts packages/*/test \
    apps/server/src/*.test.ts apps/server/src/*/*.test.ts \
    integrations/*/src/*.test.ts integrations/*/test extensions/*/
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts"]
