# Markdoc - one container serves the Next.js app and the collaboration WebSocket.
#   docker build -t markdoc . && docker run -p 3000:3000 -e AUTH_SECRET=... markdoc
# Node 22+ is required by @hocuspocus/server.
#
# PDF export drives a headless Chromium through playwright-core. Two ways to get one into the image:
#   - mcr.microsoft.com/playwright:v1.62.1-noble: the exact Chromium build playwright-core 1.62 was
#     tested with, but ~2 GB and Ubuntu-based (three browsers, all system deps).
#   - node:22-alpine + `apk add chromium`: ~150 MB on top of the base image. Alpine's Chromium is a
#     little newer/older than Playwright's pinned build, which is fine for setContent + pdf over CDP
#     but is not what Playwright tests against. Chosen here because it is a fraction of the size; the
#     executable is handed to playwright-core via CHROMIUM_PATH (see src/server/export/pdf.ts).
# Playwright launches Chromium with --no-sandbox by default, so it runs as the unprivileged `node`
# user without extra capabilities.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --fetch-retries=5

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# AUTH_SECRET is only needed at runtime; a placeholder keeps the build from failing fast checks.
# .next/cache is Turbopack's persistent build cache (~200 MB, 74 % of .next): an input to the *next*
# build only, which never happens inside an image, and read by nothing at runtime (the server needs
# .next/server, .next/static, the manifests and BUILD_ID). Removed in the same layer so neither the
# runtime stage's COPY of .next nor the `--target build` tools image (markdoc-maint) carries it.
# Turbopack writes its client chunks group-writable (0664); the chmod drops that bit in the same
# layer, so the runtime image has nothing writable by anyone but the owner.
RUN AUTH_SECRET=build-placeholder npm run build && rm -rf .next/cache && chmod -R go-w .next

FROM node:22-alpine AS runtime
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    APP_VERSION=${APP_VERSION} \
    CHROMIUM_PATH=/usr/bin/chromium-browser \
    PGLITE_DATA_DIR=/app/.data/pglite
# Chromium plus the fonts it needs to render text in the PDF. wget serves the HEALTHCHECK.
# Alpine drops superseded package versions from its repos, so pins would break rebuilds (DL3018).
# hadolint ignore=DL3018
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto-emoji \
      wget
# Everything under /app arrives owned by the unprivileged `node` user (COPY --chown) or is written by
# it (npm ci below runs as node). The `chown -R node:node /app` that used to run last, after npm ci
# and every COPY, is gone: in overlayfs it re-wrote every file into one more 144 MB layer.
COPY --chown=node:node package.json package-lock.json ./
# Files that come from the source tree, copied first so the one RUN below can fix their modes while
# /app is still small. The build stage's `COPY . .` keeps the modes of the uploaded context, and a
# context packed on Windows (az acr build) arrives with 0666 files; the classic builder ACR uses has
# no `COPY --chmod`, so `chmod -R go-w` in that RUN normalises them to 0644.
COPY --chown=node:node --from=build /app/public ./public
# The social card (src/server/og) reads its fonts from the source tree at request time.
COPY --chown=node:node --from=build /app/src/server/og/fonts ./src/server/og/fonts
# Drizzle migrations run on startup from ./drizzle (DRIZZLE_MIGRATIONS_DIR overrides).
COPY --chown=node:node --from=build /app/drizzle ./drizzle
COPY --chown=node:node --from=build /app/next.config.ts ./next.config.ts
COPY --chown=node:node --from=build /app/scripts/lib/dev-origins.mjs ./scripts/lib/dev-origins.mjs
# .data is retained only for explicit local/isolated production-image rehearsals that opt into PGlite.
# /app itself must belong to node so that `npm ci` can create node_modules. The chown is recursive
# only over what is here so far (≈ 230 KB, which the chmod re-writes into this layer anyway): the
# classic builder leaves the parent directories it creates for a directory COPY (src/, src/server/,
# src/server/og/) owned by root even with --chown.
RUN mkdir -p /app/.data && chown -R node:node /app && chmod -R go-w /app
# Run as the unprivileged user that ships with the image from here on (build steps included).
USER node
# Runtime dependencies only. @electric-sql/pglite ships its WASM/data files for those explicit
# rehearsals; ordinary production requires a nonblank DATABASE_URL. npm's cache
# lands in /home/node/.npm; the clean empties it in the same layer.
RUN npm ci --omit=dev --fetch-retries=5 && npm cache clean --force
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "dist/server.mjs"]
