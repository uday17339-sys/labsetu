import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';

/**
 * Long-lived container entry point.
 *
 * The serverless entry point is `api/index.ts`; both share `createApp()` so the
 * security headers, CORS rules and versioning cannot drift apart.
 */
async function main(): Promise<void> {
  const { app, config } = await createApp();
  const logger = new Logger('Bootstrap');

  app.enableShutdownHooks();

  await app.listen(config.API_PORT, config.API_HOST);

  logger.log(`LabSetu API listening on http://${config.API_HOST}:${config.API_PORT}`);
  logger.log(`  environment      ${config.NODE_ENV}`);
  logger.log(`  data residency   ${config.DATA_RESIDENCY_REGION}`);
  logger.log(`  encryption       ${config.ENCRYPTION_PROVIDER}`);
  logger.log(`  CORS origins     ${config.CORS_ORIGINS.join(', ')}`);

  if (config.NODE_ENV === 'production' && config.ENCRYPTION_PROVIDER === 'local') {
    // Loud on every boot, deliberately. An operator who opted in months ago
    // should be reminded that the master key is readable from the environment.
    logger.warn(
      'ENCRYPTION_PROVIDER=local in production: the master key is in an ' +
        'environment variable and anyone who can read the process environment ' +
        'can decrypt patient identifiers. Migrate to KMS before scale.',
    );
  }
}

main().catch((err) => {
  // Config validation and residency assertions land here. Failing to start is
  // the correct outcome — a process that booted without being able to encrypt
  // is worse than one that did not boot.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
