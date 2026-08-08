# =============================================================================
# LabSetu API — production image
#
# Build from the REPO ROOT so the workspace packages resolve:
#   docker build -f apps/api/Dockerfile -t labsetu-api .
#
# Debian slim rather than Alpine: Prisma's query engine links against glibc and
# OpenSSL, and the musl builds are a recurring source of "works locally, fails
# in the container" incidents. The extra ~40 MB is worth not having that class
# of problem in a clinical system.
# =============================================================================

FROM node:22-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# --- dependencies ------------------------------------------------------------
FROM base AS deps
# Copy only manifests first, so the (slow) install layer is cached until a
# dependency actually changes.
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
COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./

# Prisma client is generated inside the image, so the engine binary matches THIS
# platform rather than the developer's laptop.
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

RUN npm run build -w @labsetu/contracts \
 && npm run build -w @labsetu/crypto \
 && npm run build -w @labsetu/db \
 && npm run build -w @labsetu/api

# --- migration runner --------------------------------------------------------
# Keeps dev dependencies, because migrations need the Prisma CLI and the
# security layer needs `pg` — both devDependencies of @labsetu/db. Pruning them
# before this stage is what broke the first attempt at this image.
FROM build AS migrate
COPY packages/db/sql ./packages/db/sql
COPY packages/db/scripts ./packages/db/scripts
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/db/prisma/schema.prisma && node packages/db/scripts/apply-security.mjs"]

# --- pruned dependencies -----------------------------------------------------
# Separate stage so the runtime image is lean while `migrate` above keeps the
# tooling it needs.
FROM build AS prune
RUN npm prune --omit=dev

# --- runtime -----------------------------------------------------------------
FROM base AS runtime

# Runs unprivileged. A container escape from an image running as root is a much
# shorter path to the host than one from an unprivileged user.
RUN groupadd --system --gid 1001 labsetu \
 && useradd --system --uid 1001 --gid labsetu labsetu

COPY --from=prune --chown=labsetu:labsetu /app/node_modules ./node_modules
COPY --from=prune --chown=labsetu:labsetu /app/package.json ./package.json
COPY --from=prune --chown=labsetu:labsetu /app/packages ./packages
COPY --from=prune --chown=labsetu:labsetu /app/apps/api/dist ./apps/api/dist
COPY --from=prune --chown=labsetu:labsetu /app/apps/api/package.json ./apps/api/package.json

USER labsetu
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init reaps zombies and forwards SIGTERM, so Nest's shutdown hooks run and
# in-flight transactions finish instead of being severed mid-write.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
