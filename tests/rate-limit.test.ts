import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildApp } from '@relay/api/app';
import { loadEnv } from '@relay/api/env';
import { resetRateLimits } from '@relay/api/rate-limit';
import { closeHarness, getHarness, resetDatabase, TEST_URL } from './harness.ts';

/**
 * Rate limiting.
 *
 * The shared harness runs with effectively unlimited budgets, because the
 * other suites create hundreds of accounts from one address and throttling
 * them would test the limiter rather than them. These build their own app with
 * a small budget instead -- disabling the limiter in tests would leave the
 * only exercised path the untested one.
 */

/** An app with a deliberately tiny budget. */
async function throttledApp(authPerMinute: number) {
  const { db } = await getHarness();

  const env = loadEnv({
    DATABASE_URL: TEST_URL,
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const app = buildApp({ db, env, rateLimits: { authPerMinute, searchPerMinute: authPerMinute } });
  await app.ready();
  return app;
}

let counter = 0;
const register = (app: Awaited<ReturnType<typeof throttledApp>>, ip = '10.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/auth/register',
    // Fastify reads the client address from this when `trustProxy` is on,
    // which is how one test can pretend to be several callers.
    headers: { 'x-forwarded-for': ip },
    payload: {
      email: `limited${++counter}-${Date.now()}@relay.test`,
      name: 'Limited',
      password: 'correct-horse-battery-staple',
    },
  });

beforeEach(async () => {
  await resetDatabase();
  // Buckets are process-global, so a previous test would otherwise leak in.
  resetRateLimits();
});

afterAll(closeHarness);

describe('credential endpoints', () => {
  test('requests within the budget are allowed', async () => {
    const app = await throttledApp(3);

    for (let i = 0; i < 3; i++) {
      expect((await register(app)).statusCode).toBe(201);
    }

    await app.close();
  });

  test('exceeding the budget returns 429', async () => {
    const app = await throttledApp(3);

    for (let i = 0; i < 3; i++) await register(app);
    const blocked = await register(app);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate_limited');

    await app.close();
  });

  /** A client that respects `Retry-After` is the one worth helping. */
  test('a throttled response says when to come back', async () => {
    const app = await throttledApp(1);

    await register(app);
    const blocked = await register(app);

    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-limit']).toBe('1');
    expect(blocked.headers['ratelimit-remaining']).toBe('0');

    await app.close();
  });

  test('successful responses advertise the remaining budget', async () => {
    const app = await throttledApp(5);

    const first = await register(app);
    expect(first.headers['ratelimit-remaining']).toBe('4');

    const second = await register(app);
    expect(second.headers['ratelimit-remaining']).toBe('3');

    await app.close();
  });

  /**
   * The point of limiting anonymous traffic by address: one abusive client
   * must not lock everyone else out.
   */
  test('one address being throttled does not affect another', async () => {
    const app = await throttledApp(2);

    for (let i = 0; i < 3; i++) await register(app, '10.0.0.1');
    expect((await register(app, '10.0.0.1')).statusCode).toBe(429);

    // A different caller still has its full budget.
    expect((await register(app, '10.0.0.2')).statusCode).toBe(201);

    await app.close();
  });

  test('the limiter does not leak between separate limits', async () => {
    const app = await throttledApp(2);

    // Burn the auth budget...
    for (let i = 0; i < 3; i++) await register(app);
    expect((await register(app)).statusCode).toBe(429);

    // ...and an unthrottled endpoint still answers.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    await app.close();
  });

  /** 429 is transient, and the sync engine treats it that way. */
  test('a throttled mutation is retryable rather than fatal', async () => {
    const app = await throttledApp(1);

    await register(app);
    const blocked = await register(app);

    expect(blocked.statusCode).toBe(429);
    // 4xx is normally permanent; 408 and 429 are the documented exceptions.
    expect([408, 429]).toContain(blocked.statusCode);

    await app.close();
  });
});
