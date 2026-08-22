# Markdoc — one container serves the Next.js app and the collaboration WebSocket.
#   docker build -t markdoc . && docker run -p 3000:3000 -e AUTH_SECRET=... markdoc
# Node 22+ is required by @hocuspocus/server.

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
RUN AUTH_SECRET=build-placeholder npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache wget
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/next.config.ts ./next.config.ts
# Run as the unprivileged user that ships with the image.
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.mjs"]
