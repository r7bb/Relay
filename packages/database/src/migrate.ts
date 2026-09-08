import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './index.ts';

/** Absolute path to the generated SQL, resolved relative to this file so it
 * works regardless of the caller's working directory. */
export const MIGRATIONS_DIR = resolve(import.meta.dir, '..', 'migrations');

export function runMigrations(db: Database): Promise<void> {
  return migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
