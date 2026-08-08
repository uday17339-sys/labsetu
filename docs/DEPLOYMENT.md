# LabSetu — Deployment

Two supported topologies. Both use the same images.

| | Managed (SaaS) | Self-hosted |
|---|---|---|
| Runs on | AWS `ap-south-1` / `ap-south-2` | The lab's own server |
| Data leaves the lab | Yes, to an India-region cloud | No |
| Encryption keys | AWS KMS | Local key (explicit opt-in) |
| Who it is for | Most diagnostic labs | Government, defence-adjacent, labs that will not accept cloud |

The self-hosted edition is a first-class target, not a fallback — the report notes
every incumbent offers one, and some regulated buyers will not accept anything else.

---

## 1. One-command deployment

Requires Docker and Docker Compose.

```bash
node scripts/setup-prod-env.mjs your-lab.example.com   # generates .env.production
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

That brings up seven containers:

```
caddy      TLS termination, automatic certificates, security headers  (only :80/:443 exposed)
web        Next.js standalone server                                  (internal only)
api        NestJS API                                                 (internal only)
migrate    one-shot: prisma migrate deploy + RLS security layer       (must succeed first)
postgres   PostgreSQL 16                                              (internal only)
redis      Redis 7                                                    (internal only)
minio      S3-compatible object storage                               (internal only)
```

`PUBLIC_HOST` set to a real domain resolving to the machine gets an automatic
Let's Encrypt certificate on first boot. Use `localhost` for a local run —
Caddy issues an internal certificate instead.

### Seed a demo tenant

```bash
set -a && . ./.env.production && set +a
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  -e ENCRYPTION_MASTER_KEY -e BLIND_INDEX_KEY \
  migrate sh -c "npx tsx packages/db/prisma/seed.ts"
```

---

## 2. What the stack does for you

| Concern | How |
|---|---|
| TLS | Caddy, automatic issuance and renewal. HTTP 308-redirects to HTTPS. |
| Same-origin | The API is proxied at `/api`, so browser and server share one origin — no cross-origin cookie handling, which is where most session bugs live. |
| Network isolation | Postgres, Redis and MinIO publish **no host ports**. Only Caddy is reachable. |
| Least privilege | `api` and `web` run as uid 1001 with `read_only: true` root filesystems and `no-new-privileges`. |
| Migration ordering | `api` will not start until the `migrate` job exits 0. An API serving an un-migrated schema is worse than a delayed deploy. |
| Graceful shutdown | `dumb-init` forwards SIGTERM so Nest's shutdown hooks run and in-flight transactions complete. |
| Health | Every service has a healthcheck; Compose gates startup on them. |
| Log retention | JSON logs capped at 10 MB × 5 per container, so a chatty analyzer cannot fill the disk. |

---

## 3. Before real patient data

The stack boots and runs correctly as shipped. These remain before a live lab:

- [ ] **Move to KMS.** `ENCRYPTION_PROVIDER=local` keeps the master key in an environment variable. It is allowed only with an explicit `ENCRYPTION_LOCAL_ACK`, and the API warns loudly on every boot. Implement `KmsCryptoService`, set `ENCRYPTION_PROVIDER=kms` and `KMS_KEY_ID`.
- [ ] **Change the `labsetu_app` database password.** It defaults to a known value in `packages/db/docker/init/01-create-app-role.sql`.
- [ ] **Managed Postgres.** RDS with automated backups, PITR and encryption at rest, rather than a container with a local volume.
- [ ] **Real S3.** MinIO is fine for self-hosted; managed deployments should use S3 with Object Lock on the raw-data bucket.
- [ ] **Restore drill.** An untested backup is a hope, not a control.
- [ ] **Independent penetration test.**

---

## 4. Verification

Five suites, all runnable against a live deployment:

```bash
node scripts/smoke-test.mjs   https://your-host/api            # 53 — clinical workflow + compliance
node scripts/gateway-e2e.mjs  https://your-host/api            # 22 — analyzer -> LIMS
npx tsx apps/gateway/src/parsers/parsers.verify.ts             # 35 — ASTM/HL7 parsing
node scripts/ui-verify.mjs    https://your-host https://.../api # 37 — session, PWA, headers
node scripts/visual-verify.mjs https://your-host https://.../api # 41 — real Chromium, 4 viewports
```

**Space them out.** Each suite signs in several times and the auth endpoint is
rate-limited to 10 attempts per minute per IP. Running all five back-to-back
will trip it — which is the limiter working, not a failure.

---

## 5. Scaling path

The stack is deliberately a single machine. That is the right shape for the
first customers, and the report's own cost guidance (₹40k–₹1.5L/month) assumes it.

| Pressure | Move |
|---|---|
| CPU on report rendering | Extract `reports` to its own container — it already communicates only by queue and database |
| Ingest volume | Extract `ingest`; `IngestService.processMessage` is already a standalone entry point |
| Connection pool saturation | Add PgBouncer, or revisit the per-request transaction (ADR 0002 records the escape hatch) |
| HA required contractually | EKS across AZs, RDS Multi-AZ, ElastiCache |
| Audit table growth | Monthly range partitioning on `occurred_at` |

None of these are needed before the first paying labs, and doing them early
would buy operational complexity instead of customers.

---

## 6. The instrument gateway

The gateway does **not** run in the cloud. It runs on a machine inside the lab,
usually the Windows PC already sitting beside the analyzer.

```bash
docker build -f apps/gateway/Dockerfile -t labsetu-gateway .
docker run -d --name labsetu-gateway \
  -e GATEWAY_API_URL=https://your-lab.example.com/api \
  -v labsetu_gateway_data:/data \
  -p 5000:5000 -p 5001:5001 \
  --device=/dev/ttyUSB0 \
  labsetu-gateway node apps/gateway/dist/index.js --enrol ABCD-EFGH-JKLM
```

The `/data` volume is **mandatory**. It holds the store-and-forward outbox; if it
lives in the container's writable layer, replacing the container discards every
result captured during an internet outage.

New analyzers start in **shadow mode** — parsed and recorded, written nowhere —
until their output has been compared against manual entries. See
[INSTRUMENT_INTEGRATION.md](./INSTRUMENT_INTEGRATION.md) §7.
