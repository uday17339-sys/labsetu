/**
 * Serverless entry point (Vercel, or any Node function host).
 *
 * Deliberately plain JavaScript, and deliberately importing from `dist/`.
 *
 * Vercel compiles files under `api/` with esbuild, which does not implement
 * `emitDecoratorMetadata`. NestJS resolves its entire dependency graph from that
 * metadata, so a handler written in TypeScript here would build cleanly and then
 * fail at runtime with "Nest can't resolve dependencies" — the worst kind of
 * failure, because it only appears once deployed. The application is therefore
 * compiled by `nest build` (real tsc, real metadata) during the Vercel build,
 * and this file only forwards the request into it.
 *
 * A Nest application is expensive to construct, so it is built once per warm
 * instance and reused. `bootstrap` holds the PROMISE, not the result: two
 * requests arriving before the first finishes must await the same construction
 * rather than each starting their own and opening two Prisma clients.
 *
 * See docs/DEPLOY_VERCEL_TESTING.md. Two properties differ from the container
 * deployment and both matter:
 *
 *   - Rate limiting becomes per-instance. The throttler keeps counters in
 *     memory, so N warm instances allow N x the configured limit. Fine for a
 *     test deployment; not a substitute for a shared store in production.
 *   - Every instance opens its own connection. Use a POOLED database URL.
 *     Neon's pooled endpoint runs PgBouncer in transaction mode, which suits
 *     this codebase exactly: RLS is applied with `set_config(..., true)`, scoped
 *     to the transaction, so it is discarded when the connection is returned.
 */
const { createApp } = require('../dist/bootstrap');

let bootstrap;

async function getApp() {
  if (!bootstrap) {
    bootstrap = createApp()
      .then(async ({ app }) => {
        // `init()` rather than `listen()`: the host owns the socket. Nest still
        // wires up every module, guard, pipe and interceptor.
        await app.init();
        return app.getHttpAdapter().getInstance();
      })
      .catch((err) => {
        // Clear the cache so one failed boot does not poison every subsequent
        // request on this instance with the same rejected promise. The next
        // request gets a fresh attempt, which is what you want when the cause
        // was a transient database outage.
        bootstrap = undefined;
        throw err;
      });
  }
  return bootstrap;
}

module.exports = async function handler(req, res) {
  const app = await getApp();
  app(req, res);
};
