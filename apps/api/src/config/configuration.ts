import { z } from 'zod';

/**
 * Environment contract, validated at boot.
 *
 * The process refuses to start on invalid config rather than failing later on
 * the first request that happens to need it. In a system holding patient data,
 * "started up but cannot encrypt" is strictly worse than "did not start".
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- data residency (ARCHITECTURE.md §9) ---
  DATA_RESIDENCY_REGION: z.string().default('ap-south-1'),
  ALLOWED_RESIDENCY_REGIONS: z
    .string()
    .default('ap-south-1,ap-south-2')
    .transform((s) => s.split(',').map((r) => r.trim()).filter(Boolean)),

  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().optional(),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_BUCKET_RAW: z.string().default('labsetu-raw'),
  S3_BUCKET_REPORTS: z.string().default('labsetu-reports'),
  S3_BUCKET_ATTACHMENTS: z.string().default('labsetu-attachments'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_SECRET_PREVIOUS: z.string().optional(),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_ISSUER: z.string().default('labsetu'),
  JWT_AUDIENCE: z.string().default('labsetu-api'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  SIGNING_TOKEN_TTL_SECONDS: z.coerce.number().int().default(300),

  ENCRYPTION_PROVIDER: z.enum(['local', 'kms']).default('local'),
  ENCRYPTION_MASTER_KEY: z.string().optional(),
  KMS_KEY_ID: z.string().optional(),
  /**
   * Deliberate opt-in to the local key provider in production.
   *
   * Exists for self-hosted labs with no KMS — a real deployment target
   * (ARCHITECTURE.md §9), not a convenience. The exact sentence is required so
   * it cannot be set accidentally, and the API logs a prominent warning on
   * every boot when it is active.
   */
  ENCRYPTION_LOCAL_ACK: z
    .string()
    .optional()
    .transform((v) => v === 'i-understand-the-master-key-is-in-the-environment'),
  BLIND_INDEX_KEY: z.string().min(1),

  AUDIT_CHAIN_VERIFY_CRON: z.string().default('0 2 * * *'),
  AUDIT_ANCHOR_ENABLED: z.coerce.boolean().default(false),
  AUDIT_ANCHOR_BUCKET: z.string().default('labsetu-raw'),

  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().default(10),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_FROM: z.string().optional(),
  WHATSAPP_PROVIDER: z.string().default('none'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Run "node scripts/setup-env.mjs" from the repo root to generate a valid .env.`,
    );
  }

  const config = parsed.data;

  // --- boot-time assertions -------------------------------------------------

  if (config.ENCRYPTION_PROVIDER === 'local' && !config.ENCRYPTION_MASTER_KEY) {
    throw new Error('ENCRYPTION_PROVIDER=local requires ENCRYPTION_MASTER_KEY');
  }
  if (config.ENCRYPTION_PROVIDER === 'kms' && !config.KMS_KEY_ID) {
    throw new Error('ENCRYPTION_PROVIDER=kms requires KMS_KEY_ID');
  }

  // Data residency is asserted, not assumed. Booting into the wrong region is a
  // DPDP problem that would otherwise go unnoticed until an audit.
  if (!config.ALLOWED_RESIDENCY_REGIONS.includes(config.DATA_RESIDENCY_REGION)) {
    throw new Error(
      `DATA_RESIDENCY_REGION "${config.DATA_RESIDENCY_REGION}" is not in ` +
        `ALLOWED_RESIDENCY_REGIONS [${config.ALLOWED_RESIDENCY_REGIONS.join(', ')}]. ` +
        `LabSetu will not start outside an approved India region — see docs/ARCHITECTURE.md §9.`,
    );
  }

  if (config.NODE_ENV === 'production') {
    if (config.ENCRYPTION_PROVIDER === 'local' && !config.ENCRYPTION_LOCAL_ACK) {
      throw new Error(
        'ENCRYPTION_PROVIDER=local is not permitted in production without an explicit acknowledgement.\n\n' +
          'With the local provider the master key sits in an environment variable, so anyone who can\n' +
          'read the process environment or a container inspect can decrypt every patient identifier.\n' +
          'KMS keeps the key in hardware that never releases it.\n\n' +
          'Use ENCRYPTION_PROVIDER=kms with KMS_KEY_ID (docs/SECURITY.md §5).\n\n' +
          'Self-hosted deployments with no KMS available may opt in deliberately by setting:\n' +
          '    ENCRYPTION_LOCAL_ACK=i-understand-the-master-key-is-in-the-environment',
      );
    }
    if (config.CORS_ORIGINS.some((o) => o === '*')) {
      throw new Error('Wildcard CORS origin is not permitted in production.');
    }
    if (config.DATABASE_URL.includes('labsetu_dev_password')) {
      throw new Error('Development database credentials detected in production.');
    }
  }

  return config;
}

export const CONFIG = Symbol('LABSETU_CONFIG');
