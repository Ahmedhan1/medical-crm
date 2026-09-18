# MEDCORE API image (multi-stage). Produces a small production runtime that runs
# the Fastify backend, migrates on boot, and includes the PostgreSQL client so the
# built-in backup/restore CLI works inside the container. The SPA is served by the
# separate `web` image (see web/Dockerfile); this image is the API only.
#
#   docker build -t medcore/api .

# --- build: compile TypeScript + copy migration SQL/assets into dist ---------
FROM node:22-bookworm-slim AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# --- production dependencies only -------------------------------------------
FROM node:22-bookworm-slim AS proddeps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
# postgresql-client for pg_dump/pg_restore used by the backup CLI. curl for the
# container HEALTHCHECK. Clean apt lists to keep the image lean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY --from=proddeps /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/package.json ./package.json
# Durable state (license, backups) is a mounted volume in production.
RUN mkdir -p /data/backups /data/license && chown -R node:node /data /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:4000/health || exit 1
# The app migrates on boot; configuration comes from the environment (compose).
CMD ["node", "dist/index.js"]
