/**
 * Apply migration files to a database.
 *
 *   bun run db:migrate
 *
 * This is the path dev should use, not `drizzle-kit push`. `push` diffs the
 * schema straight onto the database and is convenient while iterating, but it
 * means development runs SQL that CI and the tests never execute -- and the
 * tests apply these files. That divergence already hid one bug: a unique index
 * present in the migration was missing from a pushed dev database, so the
 * mention handler failed on `ON CONFLICT` in dev while passing every test.
 */
import { createDatabase } from '@relay/database';
import { MIGRATIONS_DIR, runMigrations } from '@relay/database/migrate';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://relay:relay@localhost:5433/relay';

const { db, close } = createDatabase(DATABASE_URL, { max: 1 });

try {
  await runMigrations(db);
  console.log(`Migrations applied from ${MIGRATIONS_DIR}`);
} finally {
  await close();
}
