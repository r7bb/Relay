import { createDatabase } from '@relay/database';
import { buildApp } from './app.ts';
import { loadEnv } from './env.ts';

const env = loadEnv();
const { db, close } = createDatabase(env.DATABASE_URL, { max: env.DB_POOL_MAX });

const app = buildApp({ db, env, logger: env.API_LOG });

await app.listen({ port: env.API_PORT, host: env.API_HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    // Stop accepting connections and let in-flight requests finish before the
    // pool goes away, so a deploy doesn't turn into a burst of 500s.
    await app.close();
    await close();
    process.exit(0);
  });
}
