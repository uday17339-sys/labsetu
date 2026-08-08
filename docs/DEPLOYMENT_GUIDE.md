# Deployment guide

A practical, end-to-end guide to running LabSetu in production. It answers the question that
usually comes first — *can this go on Vercel?* — and then gives you three concrete paths with
exact commands.

---

> **Just testing?** [DEPLOY_VERCEL_TESTING.md](./DEPLOY_VERCEL_TESTING.md) gets you onto
> Vercel + Neon free tiers in about 20 minutes. The API *does* run on serverless well enough
> for a demo — it turns out to be stateless apart from Postgres. Everything below is about
> production, where the trade-offs land differently.

## 1. Can this run on Vercel alone?

**No, and one of the reasons is physical rather than technical.**

The system is four processes, not one:

| Process | What it is | Vercel? |
|---|---|---|
| `apps/web` | Next.js 15, App Router, all server components | **Yes — a good fit** |
| `apps/api` | NestJS, long-lived Postgres transactions, row locks | Possible, poor fit — see below |
| `apps/gateway` | **Raw TCP listeners on the lab LAN** | **Never** |
| Postgres, Redis, object storage | Stateful infrastructure | No — use managed services |

### The gateway cannot be in the cloud, at all

`apps/gateway/src/index.ts` opens `net.createServer()` listeners for ASTM E1381 and HL7 v2
MLLP, and watches directories for CSV drops. Analysers — a Mindray BC-6200, a Roche Cobas —
sit on a switch in the lab with a static private IP. They have no internet route, no
credentials, and no notion of TLS. They open a socket to a machine on their own subnet and
push bytes.

There is no Vercel deployment that can be on that subnet. The gateway runs on a small box in
the lab (a NUC, a Raspberry Pi 5, an existing Windows PC) and makes **outbound** HMAC-signed
HTTPS calls to your API. That is by design (ADR 0004) — it means the lab needs no inbound
firewall rule and no static public IP.

If a customer has no analysers to integrate, you can skip the gateway entirely. Everything
else works; results get typed in.

### Why the API is a poor fit for Vercel functions

Not impossible — genuinely a bad trade:

1. **The audit chain takes a row lock.** Every write does `SELECT … FOR UPDATE` on
   `audit_chain_head` to serialise the hash chain (ADR 0003). Serverless concurrency turns
   that into lock contention across many short-lived connections instead of a few pooled
   ones.
2. **RLS is set per transaction.** `set_config('app.tenant_id', …, true)` binds tenancy to
   the transaction. It works on serverless, but every invocation pays connection setup for a
   transaction that may run three queries.
3. **Prisma + serverless needs a pooler.** Direct connections exhaust Postgres
   `max_connections` fast. You would need PgBouncer, Neon's pooled endpoint, or Prisma
   Accelerate — another moving part, and `DATABASE_ADMIN_URL` still needs a *direct*
   connection for migrations.
4. **Cold starts on a clinical path.** A technician tapping "verify" and waiting 2–3 seconds
   for a cold Nest bootstrap is a worse experience than any hosting saving is worth.
5. **Nothing is actually gained.** The API has no traffic spikes to absorb. A single 2 vCPU
   container serves a multi-branch lab comfortably.

### What we recommend instead

> **Web on Vercel, API on a container host, database managed, gateway in the lab.**

This is the split we would ship. It gets you Vercel's CDN, preview deployments and zero-config
TLS for the part that benefits, without contorting the part that does not.

---

## 2. Three deployment paths

Pick one. They are ordered by how quickly you can be live.

| | A — Single VM | B — Vercel + managed | C — Full cloud |
|---|---|---|---|
| Time to live | ~30 minutes | ~2 hours | ~1 day |
| Monthly cost (India) | ₹3,000–6,000 | ₹5,000–12,000 | ₹25,000+ |
| Good for | Pilot, single lab, on-prem mandate | SaaS, several labs | Multi-region, 50+ labs |
| Scaling | Vertical | Web auto, API manual | Horizontal |
| Ops burden | You patch the VM | Split | Managed |

---

## Path A — single VM with Docker Compose

The fastest route to a real, TLS-secured deployment, and the one to use for a pilot or a
customer who insists data stays on their premises.

### A.1 Provision

Anything with 4 vCPU / 8 GB / 100 GB SSD. In India, in ap-south-1 (Mumbai) for DPDP residency:

- AWS `t3.large`, or
- DigitalOcean 4 vCPU droplet (Bangalore), or
- Hetzner CPX31 — cheapest, but EU-only, so **not** suitable if you are asserting India
  residency.

```bash
# Ubuntu 24.04
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
```

### A.2 DNS

Point an A record at the VM **before** you start the stack. Caddy provisions a Let's Encrypt
certificate on first boot and will fail loudly if the name does not resolve.

```
lims.yourlab.in.   A   203.0.113.42
```

Open **only** 80 and 443. Nothing else needs to be reachable — Postgres, Redis and MinIO are
on the compose network and are not published to the host.

### A.3 Configure and launch

```bash
git clone <your-repo> labsetu && cd labsetu

# Generates .env.production with fresh secrets for every field marked GENERATED.
node scripts/setup-prod-env.mjs

# Set your real hostname.
sed -i 's/^PUBLIC_HOST=.*/PUBLIC_HOST=lims.yourlab.in/' .env.production

docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

The `migrate` service runs first, applies migrations, then applies
`packages/db/sql/security.sql` — RLS on every tenant table, append-only grants on
`audit_log`, `signature`, `batch_disposition` and `certificate_of_analysis`. The API will not
start until it has completed.

### A.4 Seed

```bash
C='docker compose --env-file .env.production -f docker-compose.prod.yml'

# The base seed is TypeScript and runs through tsx, so it goes via npx rather
# than `--entrypoint node`.
$C run --rm --entrypoint npx migrate tsx packages/db/prisma/seed.ts

# The rest are plain ESM.
$C run --rm --entrypoint node migrate packages/db/scripts/sync-roles.mjs
$C run --rm --entrypoint node migrate packages/db/scripts/seed-inventory.mjs
```

Two things worth knowing about these:

- **The base seed runs once.** It creates the tenant and fails with a unique-constraint error
  (`P2002` on `Tenant`) if you run it twice. That is intended — it is a bootstrap, not a
  migration. The other three are idempotent and safe to re-run.
- **`sync-roles` is not optional** and must be re-run after **every** deploy that adds a
  permission or a role. Role rows are written once at seed time, so a new permission in the
  registry reaches nobody until this runs, and a newly added role does not exist for the
  tenant at all. The symptom is a 403 on an endpoint whose code looks perfectly correct.

### A.5 Verify

```bash
npm run verify https://lims.yourlab.in
```

405 checks across 10 suites. Treat anything other than all-passing as a failed deploy.

### A.6 Backups — do this before you have real patients

```bash
# /etc/cron.daily/labsetu-backup
#!/bin/bash
set -euo pipefail
cd /home/ubuntu/labsetu
STAMP=$(date +%F-%H%M)
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec -T postgres pg_dump -U labsetu -Fc labsetu > "/backup/labsetu-$STAMP.dump"
# Off the machine, or it is not a backup.
aws s3 cp "/backup/labsetu-$STAMP.dump" "s3://your-backups/labsetu/" --region ap-south-1
find /backup -name 'labsetu-*.dump' -mtime +14 -delete
```

**Restore-test it.** A backup you have never restored is a hypothesis:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec -T postgres pg_restore -U labsetu -d labsetu_restore_test --clean < /backup/labsetu-<stamp>.dump
```

Also back up `.env.production` **separately and encrypted**. It holds
`ENCRYPTION_MASTER_KEY` and `BLIND_INDEX_KEY`. Losing the master key means every patient
identifier is permanently unreadable — the database restore will not help you.

---

## Path B — Vercel (web) + Fly.io/Render (API) + Neon (Postgres)

The recommended split. Vercel does what it is good at; nothing is forced onto it.

### B.1 Database — Neon or Supabase, Mumbai region

```bash
# Neon: create a project in ap-south-1, then two roles.
psql "$ADMIN_URL" <<'SQL'
CREATE ROLE labsetu_app WITH LOGIN PASSWORD 'strong-password' NOBYPASSRLS NOSUPERUSER;
GRANT CONNECT ON DATABASE labsetu TO labsetu_app;
SQL
```

`NOBYPASSRLS` is load-bearing. `packages/db/scripts/apply-security.mjs` asserts it at
startup and refuses to proceed otherwise — a role that can bypass RLS makes tenant isolation
decorative.

Then, from your machine:

```bash
DATABASE_ADMIN_URL='postgresql://owner:...@ep-xxx.ap-south-1.aws.neon.tech/labsetu' \
DATABASE_URL='postgresql://labsetu_app:...@ep-xxx.ap-south-1.aws.neon.tech/labsetu' \
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma

DATABASE_ADMIN_URL=... node packages/db/scripts/apply-security.mjs
```

Migrations need the **direct** (unpooled) endpoint. The API can use the pooled one.

### B.2 API — Fly.io

```bash
fly launch --no-deploy --name labsetu-api --region bom   # Mumbai

fly secrets set \
  DATABASE_URL='postgresql://labsetu_app:...@ep-xxx-pooler.ap-south-1.aws.neon.tech/labsetu' \
  DATABASE_ADMIN_URL='postgresql://owner:...@ep-xxx.ap-south-1.aws.neon.tech/labsetu' \
  REDIS_URL='rediss://default:...@fly-labsetu-redis.upstash.io:6379' \
  JWT_SECRET="$(openssl rand -base64 48)" \
  BLIND_INDEX_KEY="$(openssl rand -base64 32)" \
  ENCRYPTION_PROVIDER=kms \
  KMS_KEY_ID='arn:aws:kms:ap-south-1:...:key/...' \
  DATA_RESIDENCY_REGION=ap-south-1 \
  CORS_ORIGINS='https://lims.yourlab.in' \
  API_PUBLIC_URL='https://api.yourlab.in'

fly deploy --dockerfile apps/api/Dockerfile --build-target runtime
```

`fly.toml`:

```toml
app = "labsetu-api"
primary_region = "bom"

[build]
  dockerfile = "apps/api/Dockerfile"

[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = false   # do NOT let it sleep — cold starts on a clinical path
  min_machines_running = 1

  [http_service.http_options.response.headers]
    Strict-Transport-Security = "max-age=31536000; includeSubDomains"

[[http_service.checks]]
  path = "/v1/ready"
  interval = "15s"
  timeout = "3s"

[[vm]]
  cpu_kind = "shared"
  cpus = 2
  memory_mb = 2048
```

`auto_stop_machines = false` matters. A scale-to-zero API means the first technician of the
morning waits for a cold start.

### B.3 Web — Vercel

```bash
cd apps/web
vercel link
vercel env add API_INTERNAL_URL production      # https://api.yourlab.in
vercel env add NODE_ENV production              # production
vercel --prod
```

In the Vercel project settings:

- **Root directory**: `apps/web`
- **Build command**: `cd ../.. && npm run build --workspace=@labsetu/web`
- **Install command**: `cd ../.. && npm ci`
- **Function region**: `bom1` (Mumbai) — required if you are asserting India residency
- **Node version**: 22.x

`API_INTERNAL_URL` is read at **runtime**, not build time. `NEXT_PUBLIC_*` values are inlined
into the bundle and cannot be changed afterwards, which is why the API URL deliberately is
not one — see the comment in `apps/web/src/lib/api.ts`.

Every API call in the web app is server-side, so the browser never sees the API host or a
token. Session cookies are `httpOnly`.

**CORS:** set `CORS_ORIGINS` on the API to exactly your Vercel domain. Vercel preview
deployments get random subdomains, so either add a wildcard for previews or accept that
previews cannot reach production data — the latter is safer.

### B.4 Redis and object storage

- **Redis**: Upstash (Mumbai) — used for rate limiting.
- **Object storage**: AWS S3 in ap-south-1 with **Object Lock enabled** on the reports
  bucket. Released report PDFs are written under a retention policy; that is what makes
  "the report cannot be altered after release" true at the storage layer rather than in
  application code.

### B.5 Gateway — in the lab, always

On a small box on the lab LAN:

```bash
docker run -d --name labsetu-gateway --restart unless-stopped \
  --network host \
  -e API_URL=https://api.yourlab.in \
  -e DEVICE_ID=<from enrolment> \
  -e DEVICE_SECRET=<shown once at enrolment> \
  -v /var/labsetu/spool:/spool \
  labsetu-gateway:latest
```

`--network host` so it can bind the analyser ports. Enrol from the API first:

```
POST /v1/ingest/devices/:id/enrolment-code   →   a one-time code
POST /v1/ingest/enrol                         →   deviceId + secret, shown once
```

The secret is displayed exactly once. It is HMAC-signing material, not a password.

---

## Path C — full cloud (AWS ap-south-1)

For 50+ labs. Sketch rather than a script, because the details are yours:

- **ECS Fargate** or **EKS** for the API, 2+ tasks behind an ALB
- **RDS Postgres 16** Multi-AZ, with `rds.force_ssl=1`
- **ElastiCache Redis**
- **S3** with Object Lock for reports, versioning for everything else
- **KMS** for `ENCRYPTION_PROVIDER=kms` — the master key never leaves the HSM
- **CloudFront** in front of the web app, or keep Vercel
- **Secrets Manager** for the environment, not a `.env` file

Everything in ap-south-1 or ap-south-2. `DATA_RESIDENCY_REGION` is asserted at API boot and
the process exits if it is set to a region outside `ALLOWED_RESIDENCY_REGIONS`.

---

## 3. Pre-flight checklist

Work through this before the first real patient record.

### Secrets and keys

- [ ] `ENCRYPTION_PROVIDER=kms` in production. `local` puts the master key in the environment,
      and the API warns on every boot for good reason.
- [ ] `ENCRYPTION_MASTER_KEY` and `BLIND_INDEX_KEY` backed up **separately** from the database,
      encrypted. Losing them is unrecoverable.
- [ ] `JWT_SECRET` at least 32 bytes of real entropy.
- [ ] `.env.production` is not in git. Check `git log --all --full-history -- .env.production`.
- [ ] Changing `BLIND_INDEX_KEY` invalidates every blind index. Do not rotate it casually — it
      requires a re-index of every patient.

### Database

- [ ] `labsetu_app` is `NOBYPASSRLS` and `NOSUPERUSER`. Confirm:
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='labsetu_app';` → `f | f`
- [ ] `apply-security.mjs` has run. Confirm the append-only grants:
      ```sql
      SELECT has_table_privilege('labsetu_app','audit_log','DELETE');          -- f
      SELECT has_table_privilege('labsetu_app','signature','UPDATE');          -- f
      SELECT has_table_privilege('labsetu_app','batch_disposition','UPDATE');  -- f
      ```
- [ ] Automated backups on, and **one restore actually tested**.
- [ ] `max_connections` comfortably above your pool size × instance count.

### Application

- [ ] `npm run verify https://your-host` — 405/405.
- [ ] `npm run db:sync-roles` after every deploy that touches permissions.
- [ ] Demo data removed: `npm run db:clean-tests -- --from-patient=<code> --apply`.
- [ ] Every seeded demo account either deleted or given a real password. `LabSetu@2026` must
      not survive contact with production.
- [ ] MFA enabled for every account holding `result:authorize` or `batch:disposition`.

### Compliance

- [ ] `DATA_RESIDENCY_REGION` matches where the data physically is.
- [ ] S3 Object Lock on the reports bucket.
- [ ] Audit chain verifies: `GET /v1/compliance/audit-chain/verify` → `PASSED`.
- [ ] Retention policy configured for your jurisdiction (COMPLIANCE.md §7).
- [ ] Competency recorded for every person who will authorise. Without it, authorisation is
      refused — correctly, and confusingly if nobody expected it.

### Operations

- [ ] Uptime check on `/v1/ready`. It reports the database state and the residency region,
      so a misconfigured deployment is visible from outside rather than only in the logs.
- [ ] Log aggregation — the API logs structured JSON.
- [ ] An alert when an analyser goes silent. `GET /v1/ingest/devices` exposes `isOnline`;
      "we did not notice it stopped sending" is the failure that actually bites labs.
- [ ] Someone's phone number for when Postgres fills its disk.

---

## 4. Day-two operations

### Deploying an update

```bash
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml build api web migrate
docker compose --env-file .env.production -f docker-compose.prod.yml up -d api web
docker compose --env-file .env.production -f docker-compose.prod.yml \
  run --rm --entrypoint node migrate packages/db/scripts/sync-roles.mjs
npm run verify https://lims.yourlab.in
```

The `migrate` service runs automatically as an API dependency, so schema changes apply before
the new API starts. Migrations in this project are additive by policy; there is no
down-migration path and `prisma migrate reset` is never run against production.

### Onboarding a new lab (tenant)

Tenancy is enforced by Postgres RLS, so a new tenant is a row plus its seeded roles. Use the
provisioning path rather than SQL — it creates the tenant, its default roles, its catalog and
its first administrator in one transaction with an audit entry.

### Rotating a leaked JWT secret

Set the new `JWT_SECRET` and restart. Every access token is immediately invalid and every
user signs in again. Refresh tokens survive — revoke those too if the leak is serious:

```sql
UPDATE refresh_token SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
```

### When someone leaves

Deactivate, never delete: `PATCH /v1/admin/users/:id { "status": "INACTIVE" }`. It bumps
`tokenVersion`, so their session dies within the access-token window rather than at expiry.
Their signatures remain attributable, which is the point.

---

## 5. Cost, honestly

Monthly, for one lab doing ~500 tests a day, in INR:

| | Path A | Path B |
|---|---|---|
| Compute | ₹3,500 (t3.large) | ₹1,700 (Fly 2×shared-2x) + ₹0 (Vercel Hobby) or ₹1,700 (Pro) |
| Database | included | ₹1,900 (Neon Scale) |
| Redis | included | ₹850 (Upstash) |
| Object storage | included | ₹400 (S3, ~50 GB) |
| Backups | ₹300 (S3) | included |
| **Total** | **~₹3,800** | **~₹4,900–6,600** |

Path A is cheaper and simpler until you are running several labs. The reason to move to B is
not cost — it is that you stop being the person who patches the VM.

---

## 6. What is deliberately not automated

Stated so nobody discovers it during an incident:

- **No down-migrations.** Rolling back a schema change means restoring a backup.
- **No blue-green deploy.** `docker compose up -d` restarts the API; expect a few seconds of
  502. Do it outside collection hours.
- **No automatic tenant provisioning from a signup form.** Onboarding a lab involves
  configuring its catalog, reference ranges and letterhead — a conversation, not a form.
- **No multi-region failover.** Single region by design; DPDP residency and a hash-chained
  audit trail with a per-tenant sequence do not want multi-master.

---

## 7. Quick reference

```bash
# Liveness (does not touch the database) and readiness (does)
curl https://lims.yourlab.in/api/v1/health
curl https://lims.yourlab.in/api/v1/ready
# → {"status":"ok","checks":{"database":"up"},"region":"ap-south-1","version":"0.1.0"}

# Full verification (405 checks)
npm run verify https://lims.yourlab.in

# Feature audit — every role, every screen
node scripts/feature-audit.mjs https://lims.yourlab.in/api https://lims.yourlab.in

# The lab owner's walkthrough — 35 real tasks
node scripts/owner-walkthrough.mjs https://lims.yourlab.in/api https://lims.yourlab.in

# Audit chain
curl -H "authorization: Bearer $TOKEN" \
  https://lims.yourlab.in/api/v1/compliance/audit-chain/verify

# Logs
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api

# Roles after a deploy
docker compose --env-file .env.production -f docker-compose.prod.yml \
  run --rm --entrypoint node migrate packages/db/scripts/sync-roles.mjs
```
