// Central configuration, read once from environment variables.
// Every value has a safe development default; production refuses to start
// without the secrets it needs.

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

const nodeEnv = env('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

function secret(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required secret ${name} in production`);
  return devDefault;
}

export const config = {
  env: nodeEnv,
  isProd,
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/reservo'),
  dbPoolMax: Number(env('DB_POOL_MAX', '10')),
  // Base URL of the platform itself, used for payment callbacks
  // (e.g. https://app.reservo.pt). Tenant sites live on their own domains.
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:3000'),
  // Platform domain used for tenant subdomains: <slug>.<platformDomain>
  platformDomain: env('PLATFORM_DOMAIN', 'localhost'),
  // 32+ random bytes, base64. Encrypts payment keys at rest (AES-256-GCM).
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  dataKey: secret('DATA_ENCRYPTION_KEY', 'ZGV2LW9ubHktZGF0YS1rZXktZG8tbm90LXVzZS0zMmI='),
  // Bearer token for POST /internal/cron (Cloud Scheduler / EventBridge).
  cronSecret: secret('CRON_SECRET', 'dev-cron-secret'),
  // Number of reverse proxies in front of the app (ALB / Cloud Run = 1).
  trustProxyHops: Number(env('TRUST_PROXY_HOPS', isProd ? '1' : '0')),
  // Allow the mock payment provider. Always false in production unless a
  // tenant is explicitly flagged as a demo tenant.
  allowMockPayments: env('ALLOW_MOCK_PAYMENTS', isProd ? 'false' : 'true') === 'true',
  // Run background jobs inside the web process (handy for single-instance
  // deployments). Jobs are guarded by Postgres advisory locks, so running
  // them in several replicas is safe.
  inlineWorker: env('INLINE_WORKER', isProd ? 'false' : 'true') === 'true',
  logLevel: env('LOG_LEVEL', isProd ? 'info' : 'debug'),
  notify: {
    // 'log' prints messages instead of sending them (development).
    emailProvider: env('EMAIL_PROVIDER', 'log'), // log | brevo
    smsProvider: env('SMS_PROVIDER', 'log'), // log | brevo
    whatsappProvider: env('WHATSAPP_PROVIDER', 'log'), // log | meta
    brevoApiKey: env('BREVO_API_KEY', ''),
    emailFrom: env('EMAIL_FROM', 'reservas@reservo.pt'),
    smsSender: env('SMS_SENDER', 'Reservas'),
    metaWhatsappToken: env('META_WHATSAPP_TOKEN', ''),
    metaWhatsappPhoneId: env('META_WHATSAPP_PHONE_ID', ''),
    // Names of pre-approved WhatsApp message templates (Meta Business).
    waTemplateConfirm: env('WA_TEMPLATE_CONFIRM', 'booking_confirmed'),
    waTemplateReminder: env('WA_TEMPLATE_REMINDER', 'booking_reminder'),
    waTemplateLang: env('WA_TEMPLATE_LANG', 'pt_PT'),
  },
  ifthenpay: {
    baseUrl: env('IFTHENPAY_BASE_URL', 'https://api.ifthenpay.com'),
    // Multibanco has a sandbox endpoint; MB WAY test keys come from ifthenpay.
    multibancoSandbox: env('IFTHENPAY_MB_SANDBOX', 'false') === 'true',
    timeoutMs: Number(env('IFTHENPAY_TIMEOUT_MS', '10000')),
  },
  retentionMonths: Number(env('CUSTOMER_RETENTION_MONTHS', '24')),
  media: {
    // 'local' keeps files under MEDIA_DIR and serves them at /media (development,
    // tests); 's3' stores them in MEDIA_BUCKET, served by CloudFront at MEDIA_BASE_URL.
    storage: env('MEDIA_STORAGE', isProd ? 's3' : 'local') as 'local' | 's3',
    dir: env('MEDIA_DIR', 'data/media'),
    bucket: env('MEDIA_BUCKET', ''),
    region: env('AWS_REGION', 'eu-west-1'),
    // Where browsers load images from. Local: a path on the same host.
    baseUrl: env('MEDIA_BASE_URL', '/media').replace(/\/$/, ''),
    maxBytes: Number(env('MEDIA_MAX_BYTES', String(5 * 1024 * 1024))),
    maxPerTenant: Number(env('MEDIA_MAX_PER_TENANT', '200')),
  },
} as const;

export type Config = typeof config;
