# Deploying to Vercel + Neon (free tier, testing)

A working test deployment on free tiers, in about 20 minutes. Two Vercel projects, one Neon
database, no card required.

**This is for a testing deployment with synthetic data.** Section 7 lists exactly what makes
it unsuitable for real patients, so nobody has to guess.

---

## What actually runs

Earlier advice in [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) says the API is a poor fit for
serverless. That is still true for production. For testing it works, and better than expected,
because of three things that turned out to be true when checked rather than assumed:

- **Redis is not connected to.** `REDIS_URL` exists in the config schema but nothing dials it.
  Rate limiting uses the throttler's in-memory store.
- **There is no S3 client.** Report PDFs are recorded by key; nothing uploads at runtime.
- **There are no cron jobs or background workers.**

So the API is stateless apart from Postgres. That is what makes a function host viable.

| Piece | Where | Free tier |
|---|---|---|
| Web (Next.js) | Vercel project #1 | Hobby |
| API (NestJS) | Vercel project #2 | Hobby |
| Postgres | Neon | Free (0.5 GB) |
| Instrument gateway | **not deployed** | — |

The gateway is skipped entirely. It opens TCP listeners on a lab LAN for analysers; there is
nothing to connect to in a test deployment, and no cloud function can host it regardless.
Results get typed in, which is what a demo does anyway.

---

## 1. Neon

Create a project at [neon.tech](https://neon.tech).

- **Region:** Singapore (`ap-southeast-1`) — the closest free region to India. Neon's free
  tier does not offer Mumbai. Fine for synthetic data; see §7.
- **Postgres version:** 16 or 17.

From **Connection Details**, copy the **Direct connection** string — *not* pooled. It looks
like:

```
postgresql://neondb_owner:npg_xxxxx@ep-cool-name-12345678.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

Then, from the repository root:

```bash
npm install
node scripts/setup-neon.mjs "postgresql://neondb_owner:...@ep-....aws.neon.tech/neondb?sslmode=require"

```

That single command:

1. creates the `labsetu_app` role with `NOBYPASSRLS` — the security layer asserts this and
   refuses to proceed otherwise, because a role that can bypass RLS makes tenant isolation
   decorative;
2. applies migrations over the direct connection;
3. applies RLS policies and the append-only grants on `audit_log`, `signature`,
   `batch_disposition` and `certificate_of_analysis`;
4. seeds the tenant, manufacturing roles, methods, specifications, materials, batches and
   lab consumables;
5. writes **`.env.vercel.api`** and **`.env.vercel.web`** with freshly generated secrets.

It refuses a pooled URL, because PgBouncer in transaction mode cannot run DDL and the failure
would be confusing.

> **Keep those two files.** They hold `ENCRYPTION_MASTER_KEY` and `BLIND_INDEX_KEY`. Lose them
> and every encrypted patient identifier is permanently unreadable — a database backup does
> not help. Both are gitignored.

---

## 2. Push to a Git repository

Vercel deploys from Git.

```bash
git add -A
git commit -m "LabSetu"
git remote add origin https://github.com/<you>/labsetu.git
git push -u origin main
```

Confirm the secrets did not go with it:

```bash
git ls-files | grep -E '\.env' || echo "clean"
```

---

## 3. The API project

New Project → import the repo → **before deploying**, set:

| Setting | Value |
|---|---|
| Project Name | `labsetu-api` |
| **Root Directory** | `apps/api` |
| Framework Preset | **Other** |
| Include files outside root directory | **on** (it is a monorepo) |
| Node.js Version | 22.x |
| Build Command | **leave empty** |
| Install Command | **leave empty** |
| Output Directory | **leave empty** |

Leaving those three empty matters. Anything typed into them overrides `vercel.json`, and the
override is invisible in the repo — a later reader sees the file and believes it.

Leave build and install commands alone — `apps/api/vercel.json` sets them, and they climb to
the repository root so npm workspaces resolve.

Add environment variables from `.env.vercel.api` (Settings → Environment Variables → paste
into the bulk editor). Leave `CORS_ORIGINS` as the placeholder for now.

Deploy. Then check:

```bash
curl https://labsetu-api-xxxx.vercel.app/v1/health
# {"status":"ok","uptime":0}

curl https://labsetu-api-xxxx.vercel.app/v1/ready
# {"status":"ok","checks":{"database":"up"},"region":"ap-south-1","version":"0.1.0"}
```

`/v1/ready` touching the database is the real test. If it says `"database":"down"`, the
`DATABASE_URL` is wrong — almost always the direct endpoint pasted where the pooled one
belongs.

### How the API runs as a function

`apps/api/api/index.js` is a deliberately plain-JavaScript handler that requires the
tsc-compiled `dist/`. Vercel compiles files under `api/` with esbuild, which does not
implement `emitDecoratorMetadata`; NestJS resolves its entire dependency graph from that
metadata, so a TypeScript handler would build cleanly and then fail at runtime with "Nest
can't resolve dependencies". Compiling with real `tsc` and forwarding into the output avoids
that entirely.

The build calls `tsc` directly rather than `nest build`. The Nest CLI adds nothing here —
`nest-cli.json` sets only `deleteOutDir`, with no assets and no plugins — and it is one fewer
devDependency that has to survive the install.

The Nest app is constructed once per warm instance and cached as a *promise*, so concurrent
cold requests await one construction rather than each building their own.

---

## 4. The web project

New Project → same repo → **Add New… → Project** again:

| Setting | Value |
|---|---|
| Project Name | `labsetu-web` |
| **Root Directory** | `apps/web` |
| Framework Preset | **Next.js** (detected) |
| Include files outside root directory | **on** |
| Node.js Version | 22.x |

Environment variables:

```
API_INTERNAL_URL = https://labsetu-api-xxxx.vercel.app
NODE_ENV         = production
```

`API_INTERNAL_URL` is read at runtime and is deliberately **not** a `NEXT_PUBLIC_*` variable:
those are inlined into the browser bundle at build time and cannot be changed afterwards.
Every API call in this app is server-side, so the browser never sees the API host or a token.

Deploy.

---

## 5. Close the loop on CORS

Go back to the **API** project and set:

```
CORS_ORIGINS = https://labsetu-web-xxxx.vercel.app
```

Redeploy the API (Deployments → ⋯ → Redeploy). Environment changes do not apply to an
existing deployment.

Preview deployments get random subdomains and will not match. Either add each one you care
about, or accept that previews cannot reach the API — the latter is safer and usually right.

---

## 6. Verify

```bash
npm run verify https://labsetu-web-xxxx.vercel.app
```

405 checks across 10 suites. Expect two differences from a container deployment:

- **Slower.** Cold starts on the first request to each function instance.
- **Rate-limit checks may not fire.** The throttler counts in memory, so each instance has its
  own counter and the effective limit is much looser. The suite backs off and retries on 429,
  so it passes either way — but a passing rate-limit assertion means less here.

Then the feature audit, which walks every screen as every role:

```bash
node scripts/feature-audit.mjs https://labsetu-api-xxxx.vercel.app https://labsetu-web-xxxx.vercel.app
```

Sign in at your web URL:

```
Tenant     VANTAGE
Email      admin@vantage.test
Password   LabSetu@2026
```

Other seeded accounts, same password: `qa@`, `qc@`, `qc2@`, `stores@` and
`auditor@vantage.test`. Each lands on a dashboard for their own job, which is
worth showing — the stores officer sees consignments awaiting sampling, the
analyst sees a worklist, QA sees batches waiting on a release decision.

---

> **Region.** `regions` is a Pro feature, so it is not set. On Hobby your functions run in
> Vercel's default region (usually `iad1`, US East) while Neon is in Singapore — every query
> crosses the Pacific. Expect a few hundred milliseconds per request. Fine for a demo, and
> another reason §7 says this is not a production deployment.

---

## 7. What this deployment is not

Stated plainly so it is never assumed otherwise.

| | Why it matters |
|---|---|
| **Not India-resident.** Neon's free tier has no Mumbai region; your data is in Singapore. | DPDP Act residency is not met. Synthetic data only — no real patient ever. |
| **Rate limiting is per-instance.** In-memory counters across N warm functions. | Brute-force protection is materially weaker than the configured 10/min. |
| **The master key is in an environment variable.** `ENCRYPTION_PROVIDER=local`. | Anyone with Vercel project access can decrypt patient identifiers. Production uses KMS. |
| **No object storage.** Report PDFs are recorded by key, not stored. | Reports render from the database; there is nothing to download. |
| **No instrument integration.** The gateway is not deployed. | Results are typed in. Nothing exercises the ASTM/HL7 path. |
| **Neon free tier sleeps** after ~5 minutes idle. | First request after a pause takes several seconds. Combined with a Vercel cold start, the first sign-in of the day is slow. |
| **0.5 GB storage, 190 compute-hours/month.** | Ample for a demo; it will not hold a real lab's year. |
| **Vercel Hobby is non-commercial.** Per Vercel's terms. | A paying customer on this is a licence violation. Move to Pro, or to [Path A or B](./DEPLOYMENT_GUIDE.md). |

When it stops being a test, [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) Path A is a single
VM at about ₹3,800/month and fixes every row in that table.

---

## 8. Troubleshooting

**`sh: line 1: tsc: command not found`** (or `nest`, or `prisma`)
`NODE_ENV=production` is set in the Vercel environment, and npm omits devDependencies when it
sees that — removing TypeScript and the Prisma CLI, which the build needs. The error names the
symptom, nowhere near the cause.

The repo-root **`.npmrc`** fixes it:
```
include=dev
```
That is deliberately not just a flag on `installCommand`, because **a dashboard override wins
over `vercel.json`**. If Settings → General → Install Command has anything in it, Vercel uses
that and ignores the file. `.npmrc` holds either way, since npm reads it whatever the command.

Check the build log's third line. It should read:
```
Running "install" command: `cd ../.. && npm install --include=dev`...
```
If it says plain `npm install`, either the commit predates the fix or the dashboard is
overriding — clear the field so it falls back to `vercel.json`.

Do **not** solve this by dropping `NODE_ENV=production`. The API needs it at runtime for HSTS
and the strict CSP.

**The browser shows your JavaScript source instead of running it**
`outputDirectory` was pointing at the project root, so Vercel published the source tree as a
static site and served `api/index.js` as text. It must point at a directory containing only
static assets — `apps/api/public/` exists and is empty for exactly this reason:

```json
"outputDirectory": "public",
"rewrites": [{ "source": "/(.*)", "destination": "/api" }]
```

`api/index.js` maps to the route `/api` by the index convention, and a Vercel rewrite
preserves the original request path in `req.url`, so Express still sees `/v1/ready`.

**`Nest can't resolve dependencies of the …`**
The handler compiled your TypeScript with esbuild instead of using `dist/`. Confirm
`apps/api/api/index.js` is `.js`, not `.ts`, and that the build ran `nest build` — check the
Vercel build log for `> nest build`.

**`Query engine library for current platform "rhel-openssl-3.0.x" could not be found`**
`prisma generate` did not run in the Vercel build, or `binaryTargets` lost the RHEL entry.
`packages/db/prisma/schema.prisma` must have:
```prisma
binaryTargets = ["native", "rhel-openssl-3.0.x"]
```
and `npm run vercel:build:api` runs `prisma generate` first.

**`too many connections for role`**
`DATABASE_URL` is the direct endpoint. Use the pooled one — hostname contains `-pooler` — with
`?pgbouncer=true&connection_limit=1`.

**Every request 401s after signing in**
`CORS_ORIGINS` on the API does not include the web origin, so the browser drops the
`Set-Cookie`. Set it exactly, then redeploy the API.

**403 on an endpoint whose code is obviously right**
Roles are seeded once. Run the reconciliation:
```bash
DATABASE_URL='<pooled>' node packages/db/scripts/sync-roles.mjs
```
This is needed after any deploy that adds a permission or a role.

**`FUNCTION_INVOCATION_TIMEOUT` on the first request**
Cold start plus a sleeping Neon endpoint. Hit `/v1/ready` once to wake both. `maxDuration` is
set to 30s in `apps/api/vercel.json`.

**Migrations fail with `prepared statement already exists`**
Migrations were pointed at the pooled endpoint. Use `DATABASE_ADMIN_URL` (direct) for
anything schema-related.

---

## 9. Redeploying after a change

```bash
git push                      # both projects rebuild automatically

# only if the change touched permissions or roles
DATABASE_URL='<pooled url>' node packages/db/scripts/sync-roles.mjs

# only if the change added a migration
DATABASE_ADMIN_URL='<direct url>' \
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
DATABASE_ADMIN_URL='<direct url>' node packages/db/scripts/apply-security.mjs
```

Migrations do not run automatically on Vercel — there is no migrate container. Run them from
your machine before pushing a schema change, since the new code will expect the new schema.
