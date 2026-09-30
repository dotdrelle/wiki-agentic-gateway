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
# The runtime never invokes npm or corepack (ENTRYPOINT is node directly):
# removing them drops npm's bundled pacote/sigstore/@sigstore/picomatch/
# ip-address/brace-expansion/... from the shipped image, which image scanners
# otherwise report as installed, vulnerable distributions.
# git: worktree runs (agent.curate) create one branch per objective and diff
# against it — the merge/review machinery lives in the workspace git repo.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg && \
    apt-get update && \
    apt-get install -y --no-install-recommends git && \
    apt-get upgrade -y && \
    rm -rf /var/lib/apt/lists/*
# `--chown`: COPY keeps the host's permission bits, so a restrictive umask on
# the build machine would leave the sources unreadable for `node`.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

EXPOSE 7789

USER node

ENTRYPOINT ["node", "bin/wiki-agentic-gateway.js"]
