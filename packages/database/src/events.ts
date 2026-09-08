import { MAX_NOTIFY_BYTES, REALTIME_CHANNEL, type ServerEvent } from '@relay/shared';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Executor } from './index.ts';

/**
 * Realtime fan-out backplane, built on Postgres LISTEN/NOTIFY.
 *
 * The plan called for Redis pub/sub. Postgres is used instead for two reasons,
 * one principled and one practical.
 *
 * The principled one: `NOTIFY` is transactional. A notification emitted inside
 * a transaction is delivered only if that transaction commits, and never
 * before. Publishing to Redis from inside a database transaction has no such
 * guarantee -- the message can go out and then the transaction can roll back,
 * so every client refetches and sees the old value. Getting that right against
 * Redis needs an outbox table and a relay process; here it is free.
 *
 * The practical one: it is one fewer service to run, and this deployment has no
 * Redis available.
 *
 * What it costs: notifications are fire-and-forget with no persistence, so a
 * gateway that is down misses them (clients refetch on reconnect, which is why
 * events carry ids rather than state). Payloads cap at 8000 bytes, and every
 * listener holds an idle connection. At high fan-out, Redis is the right
 * replacement -- but only the two functions below would change.
 */

/**
 * Events carry identifiers, never row contents.
 *
 * A payload would have to be filtered per recipient -- an event about an issue
 * must not leak fields to someone whose role cannot read them -- and would go
 * stale between publish and delivery. Sending an id and letting the client
 * refetch through the normal authorized endpoint keeps one authorization path
 * instead of two.
 */
export async function publishEvent(db: Executor, event: ServerEvent): Promise<void> {
  const payload = JSON.stringify(event);

  if (Buffer.byteLength(payload, 'utf8') > MAX_NOTIFY_BYTES) {
    throw new Error(`Realtime payload too large for NOTIFY: ${event.type}`);
  }

  // `pg_notify` rather than `NOTIFY`, because the statement form takes a
  // literal channel name and cannot be parameterised.
  await db.execute(sql`select pg_notify(${REALTIME_CHANNEL}, ${payload})`);
}

export type Unsubscribe = () => Promise<void>;

/**
 * Subscribe to the event channel. Takes the raw postgres.js client because
 * LISTEN holds a dedicated connection for its lifetime and must not be handed
 * back to the pool between notifications.
 */
export async function subscribeToEvents(
  client: postgres.Sql,
  onEvent: (event: ServerEvent) => void,
): Promise<Unsubscribe> {
  const subscription = await client.listen(REALTIME_CHANNEL, (payload) => {
    try {
      onEvent(JSON.parse(payload) as ServerEvent);
    } catch {
      // A malformed payload is not worth tearing the listener down for.
    }
  });

  return () => subscription.unlisten();
}
