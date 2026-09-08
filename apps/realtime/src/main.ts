import { createDatabase } from '@relay/database';
import postgres from 'postgres';
import { createGateway } from './gateway.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const PORT = Number(process.env.REALTIME_PORT ?? 4001);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

const { db, close } = createDatabase(DATABASE_URL, { max: 5 });

// LISTEN occupies a connection for as long as it is subscribed, so it gets its
// own single-connection client instead of starving the query pool.
const listenClient = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });

const gateway = await createGateway({ db, listenClient, port: PORT, webOrigin: WEB_ORIGIN });

console.log(`Realtime gateway listening on ws://localhost:${gateway.port}/ws (instance ${gateway.instanceId.slice(0, 8)})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await gateway.close();
    await listenClient.end({ timeout: 5 });
    await close();
    process.exit(0);
  });
}
