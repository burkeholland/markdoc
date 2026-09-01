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
RUN npm ci

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
RUN AUTH_SECRET=build-placeholder npm run build && rm -rf .next/cache

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
COPY package.json package-lock.json ./
# Runtime dependencies only. @electric-sql/pglite ships its WASM/data files inside the package, so
# the embedded database (used when DATABASE_URL is not set) needs nothing else copied.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# The social card (src/server/og) reads its fonts from the source tree at request time.
COPY --from=build /app/src/server/og/fonts ./src/server/og/fonts
# Drizzle migrations run on startup from ./drizzle (DRIZZLE_MIGRATIONS_DIR overrides).
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/scripts/lib/dev-origins.mjs ./scripts/lib/dev-origins.mjs
# Run as the unprivileged user that ships with the image; .data is where PGlite writes when no
# DATABASE_URL is given (mount a volume there to keep it).
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "dist/server.mjs"]
