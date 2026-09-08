import { MAX_NOTIFY_BYTES, PRESENCE_CHANNEL, type PresenceMessage } from '@relay/shared';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Executor } from './index.ts';

/** Gossip a presence delta to the other gateway instances. See `events.ts`
 * for why Postgres NOTIFY is the backplane rather than Redis. */
export async function publishPresence(db: Executor, message: PresenceMessage): Promise<void> {
  const payload = JSON.stringify(message);
  if (Buffer.byteLength(payload, 'utf8') > MAX_NOTIFY_BYTES) return;

  await db.execute(sql`select pg_notify(${PRESENCE_CHANNEL}, ${payload})`);
}

export async function subscribeToPresence(
  client: postgres.Sql,
  onMessage: (message: PresenceMessage) => void,
): Promise<() => Promise<void>> {
  const subscription = await client.listen(PRESENCE_CHANNEL, (payload) => {
    try {
      onMessage(JSON.parse(payload) as PresenceMessage);
    } catch {
      // Ignore malformed gossip rather than dropping the subscription.
    }
  });

  return () => subscription.unlisten();
}
