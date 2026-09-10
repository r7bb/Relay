import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** Session cookies are HTTPS-only unless explicitly relaxed for local dev. */
  COOKIE_SECURE: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v.toLowerCase() === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Postgres pool size. Every request resolves a session and checks
   * membership before its own query, so this bounds concurrency well below
   * what the connection count suggests.
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /**
   * Per-request logging. On by default; the load harness turns it off so the
   * benchmark measures the server rather than the cost of serializing a log
   * line per request to a pipe.
   */
  API_LOG: z
    .string()
    .default('1')
    .transform((v) => v === '1' || v.toLowerCase() === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}
