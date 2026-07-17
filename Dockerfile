FROM node:20-bookworm-slim AS build
# Toolchain for native-module source builds on platforms without prebuilt
# binaries (e.g. better-sqlite3 on linux/arm64). Build stage only.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY bundles ./bundles
COPY skills ./skills
RUN npm run build

# ── indexer: builds a fresh search index from cometchat/docs at image build
# time. Used only by the `full` target (ECS-style immutable images).
FROM build AS indexer
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG DOCS_REPO_URL=https://github.com/cometchat/docs.git
ARG DOCS_REF=main
RUN git clone --depth 1 --branch "$DOCS_REF" "$DOCS_REPO_URL" /tmp/docs \
    && DOCS_REPO=/tmp/docs INDEX_PATH=/app/data/index.sqlite npx tsx scripts/build-index.ts \
    && rm -rf /tmp/docs

# ── core: shared runtime contents ──
FROM node:20-bookworm-slim AS core
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bundles ./bundles
COPY --from=build /app/skills ./skills
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /app/data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1))"
CMD ["node", "dist/server.js"]

# ── full: immutable image with the index baked in (ECS / any platform that
# deploys images rather than hosts). Build with:  docker build --target full .
# Requires network access to clone cometchat/docs during the build.
FROM core AS full
COPY --from=indexer --chown=node:node /app/data/index.sqlite /app/data/index.sqlite

# ── runtime (DEFAULT): ships without the index — mount it at /app/data or
# build it in the container before launch (see DEPLOY.md). Kept as the default
# target so plain `docker build .` needs no network beyond npm.
FROM core AS runtime
