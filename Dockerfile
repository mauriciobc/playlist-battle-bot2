# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 native addon: toolchain for node-gyp when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Reuse the already-resolved/pruned tree from build (avoids a second npm ci
# against better-sqlite3, which is what failed on slim runtimes before).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# SQLite lives on the data volume: it must exist and be writable by the non-root
# runtime user, otherwise a fresh named volume (root-owned) cannot be written.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
