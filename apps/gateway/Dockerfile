# =============================================================================
# LabSetu instrument gateway — runs ON THE LAB'S PREMISES, not in the cloud.
#
# Build from the REPO ROOT:
#   docker build -f apps/gateway/Dockerfile -t labsetu-gateway .
#
# Most labs will run this on a Windows PC beside the analyzer; the container is
# for sites that already run Docker, and for reproducible testing.
#
# Serial (RS-232) analyzers need the device passed through:
#   docker run --device=/dev/ttyUSB0 ...
# =============================================================================

FROM node:22-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/crypto/package.json   ./packages/crypto/
COPY packages/db/package.json       ./packages/db/
COPY apps/api/package.json          ./apps/api/
COPY apps/web/package.json          ./apps/web/
COPY apps/gateway/package.json      ./apps/gateway/
RUN npm ci --include=dev --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY packages/crypto ./packages/crypto
COPY apps/gateway ./apps/gateway
RUN npm run build -w @labsetu/contracts \
 && npm run build -w @labsetu/crypto \
 && npm run build -w @labsetu/gateway
RUN npm prune --omit=dev

FROM base AS runtime
RUN groupadd --system --gid 1001 labsetu \
 && useradd --system --uid 1001 --gid labsetu labsetu

COPY --from=build --chown=labsetu:labsetu /app/node_modules ./node_modules
COPY --from=build --chown=labsetu:labsetu /app/package.json ./package.json
COPY --from=build --chown=labsetu:labsetu /app/packages ./packages
COPY --from=build --chown=labsetu:labsetu /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build --chown=labsetu:labsetu /app/apps/gateway/package.json ./apps/gateway/package.json

# The store-and-forward outbox MUST be a mounted volume. If it lives in the
# container's writable layer, replacing the container discards every result the
# lab captured during an outage.
RUN mkdir -p /data/outbox && chown -R labsetu:labsetu /data
VOLUME ["/data"]
ENV GATEWAY_OUTBOX_PATH=/data/outbox
ENV GATEWAY_CONFIG_PATH=/data/gateway.config.json

USER labsetu

# ASTM over TCP, and HL7 over MLLP.
EXPOSE 5000 5001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/gateway/dist/index.js"]
