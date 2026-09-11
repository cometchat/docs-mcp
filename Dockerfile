# Single-file build. Two targets:
#   docker build --target runtime -t cometchat-mcp:base .        # hermetic, no docs clone
#   docker build --target full --build-arg DOCS_COMMIT=<sha> -t <img>:<tag> .
#
# Works on BuildKit (Docker 23+ default) and on the legacy builder alike:
# `runtime` is declared BEFORE `indexer`, and both builders stop at --target,
# so --target runtime never executes the docs clone on either one.
#
# NOTE: a bare `docker build .` with no --target now builds `full` (the last
# stage) and will FAIL on the DOCS_COMMIT guard below. That is deliberate —
# but it means every call site must pass --target explicitly.

# Node 24 (LTS) is the node-version CI tests on (.github/workflows/ci.yml);
# keep the two in step. Node 20 reached end of life in April 2026.
FROM node:24-bookworm-slim AS build
# Toolchain for native-module source builds (better-sqlite3 has no prebuilt
# binaries on some architectures, e.g. linux/arm64).
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 make g++ >/dev/null \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY bundles ./bundles
COPY skills ./skills
RUN npm run build

# ── target: runtime ── app only, never touches the docs repo ────────────────
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bundles ./bundles
COPY --from=build /app/skills ./skills
COPY --from=build /app/scripts ./scripts
# scripts/build-index.ts runs under tsx both here (baking the index) and at
# runtime (in-container refresh), and it imports ../src/lib/*. The server runs
# from dist/, but the build script needs the TypeScript sources it imports, or
# every index build fails with ERR_MODULE_NOT_FOUND.
COPY --from=build /app/src ./src
# git is required at RUNTIME for the in-container index refresh
# (INDEX_AUTO_REFRESH): the sparse, blobless clone fetches only mdx blobs
# (~44MB) — a codeload tarball of the docs repo is ~390MB and cannot be filtered.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null \
    && rm -rf /var/lib/apt/lists/*
# /app/data/generations is the index-refresh work dir (INDEX_WORK_DIR) and the
# usual mount point for its volume. It must exist AND be owned by `node` so the
# non-root user can write to it when nothing is mounted, or on a Docker named
# volume (which copies this ownership). Orchestrator volumes generally do NOT
# inherit it: on Fargate use an init-perms container, on Kubernetes fsGroup.
RUN mkdir -p /app/data/generations && chown -R node:node /app/data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1))"
CMD ["node", "dist/server.js"]

# ── indexer ── builds the index; only runs for --target full ────────────────
FROM runtime AS indexer
USER root
ARG DOCS_REPO_URL=https://github.com/cometchat/docs.git
ARG DOCS_REF=main
# DOCS_COMMIT is the cache-buster AND the provenance label: pass the full docs
# sha. A new sha forces a fresh clone + index; an unchanged sha legitimately
# reuses the cached one. The guard below refuses the default rather than let a
# warm cache silently ship a stale index. (A moving ref such as "main" would
# pass the guard but is a constant cache key, so don't.)
ARG DOCS_COMMIT=unpinned
# Sparse, blobless clone of top-level files + *.mdx anywhere ('/*' keeps root
# files, '!/*/' drops directories, '**/*.mdx' re-includes the docs tree), then
# check out exactly DOCS_COMMIT so the label on `full` matches what was indexed.
RUN test "${DOCS_COMMIT}" != "unpinned" || { echo "ERROR: --build-arg DOCS_COMMIT=<sha> is required for --target full"; exit 1; } \
    && echo "baking index: ${DOCS_REPO_URL}@${DOCS_REF} (${DOCS_COMMIT})" \
    && git clone --depth 1 --filter=blob:none --sparse --branch "${DOCS_REF}" "${DOCS_REPO_URL}" /tmp/docs \
    && git -C /tmp/docs sparse-checkout set --no-cone '/*' '!/*/' '**/*.mdx' \
    && git -C /tmp/docs fetch --depth 1 origin "${DOCS_COMMIT}" \
    && git -C /tmp/docs checkout "${DOCS_COMMIT}" \
    && DOCS_REPO=/tmp/docs INDEX_PATH=/app/data/index.sqlite npx tsx scripts/build-index.ts \
    && rm -rf /tmp/docs

# ── target: full ── runtime + baked index ───────────────────────────────────
FROM runtime AS full
ARG DOCS_COMMIT=unpinned
LABEL com.cometchat.docs-commit="${DOCS_COMMIT}"
COPY --from=indexer --chown=node:node /app/data/index.sqlite /app/data/index.sqlite
