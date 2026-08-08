# =============================================================================
# LabSetu web — production image
#
# Build from the REPO ROOT:
#   docker build -f apps/web/Dockerfile -t labsetu-web .
# =============================================================================

FROM node:22-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- dependencies ------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/crypto/package.json   ./packages/crypto/
COPY packages/db/package.json       ./packages/db/
COPY apps/api/package.json          ./apps/api/
COPY apps/web/package.json          ./apps/web/
COPY apps/gateway/package.json      ./apps/gateway/
RUN npm ci --include=dev --ignore-scripts

# --- build -------------------------------------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN npm run build -w @labsetu/contracts

# NEXT_PUBLIC_* values are inlined at build time, so the API URL must be known
# here. It is a public URL, not a secret — no credential is baked in.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NODE_ENV=production

RUN npm run build -w @labsetu/web

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# `output: standalone` emits a minimal server plus only the node_modules it
# actually traced, so nothing else needs copying.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
