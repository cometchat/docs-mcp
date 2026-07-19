FROM node:20-bookworm-slim AS build
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

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bundles ./bundles
COPY --from=build /app/skills ./skills
COPY --from=build /app/scripts ./scripts
# Index is mounted at /app/data, built in the container before launch, or
# baked in via Dockerfile.full (image-based deploys, e.g. ECS).
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1))"
CMD ["node", "dist/server.js"]
