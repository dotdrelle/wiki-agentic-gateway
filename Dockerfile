# better-sqlite3 is a native module whose prebuilds are fetched from GitHub
# releases at install time. When that host is unreachable (proxied/offline
# networks), prebuild-install falls back to node-gyp, which needs a toolchain
# the slim image does not carry. The builder stage therefore installs
# python3/make/g++ so the fallback always succeeds; the runtime stage stays
# slim and ships only node_modules + sources.
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

EXPOSE 7789

ENTRYPOINT ["node", "bin/wiki-agentic-gateway.js"]
