# Self-host build for the canvas stack (web + API + worker).
# Usage: see docs/DEPLOYING.md — `docker compose up --build` is the short path.

FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Install dependencies from manifests first so source edits don't invalidate this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/canvas-core/package.json packages/canvas-core/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY plugins/split-list/package.json plugins/split-list/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# `vite build` directly (not the web `build` script): the release validator in that
# script is a deploy-pipeline gate for the hosted product, irrelevant to self-hosting.
RUN pnpm --filter @weftcanvas/contracts build \
  && pnpm --filter @weftcanvas/canvas-api build \
  && pnpm --filter @weftcanvas/canvas-worker build \
  && pnpm --filter @weftcanvas/canvas-web exec vite build

# One image serves both api and worker; compose overrides the command.
FROM node:22-bookworm-slim AS api-runtime
ENV NODE_ENV=production
# nginx and published ports reach the API through the container network.
ENV CANVAS_API_HOST=0.0.0.0
WORKDIR /repo
COPY --from=build /repo ./
EXPOSE 8787
CMD ["sh", "-c", "node apps/api/dist/database/migrate.js && node apps/api/dist/server.js"]

FROM nginx:1.27-alpine AS web-runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
