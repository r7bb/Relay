import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export * from './documents.ts';
export * from './events.ts';
export * from './presence-bus.ts';
export * from './queries.ts';
export * from './schema.ts';
export { schema };

export type Database = ReturnType<typeof createDatabase>['db'];

/** A transaction handle. Services accept `Database | Tx` so they compose. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type Executor = Database | Tx;

export function createDatabase(url: string, options: { max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    // Prepared statements are per-connection; disabling them keeps behaviour
    // identical if this ever sits behind a transaction-mode pooler (PgBouncer).
    prepare: false,
    onnotice: () => {},
  });

  // Column names are spelled out explicitly in schema.ts, so no casing
  // strategy is configured here -- there is nothing left to infer.
  const db = drizzle(client, { schema });

  return { db, client, close: () => client.end({ timeout: 5 }) };
}
