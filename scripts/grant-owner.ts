/**
 * Create an account (or reuse an existing one) and make it OWNER of every
 * workspace in the database.
 *
 *   bun run scripts/grant-owner.ts rohit@relay.dev "Rohit Biju" my-password
 *
 * Password is optional for an account that already exists; supplying one resets
 * it. Intended for local development and for bootstrapping the first admin on a
 * fresh deployment, where there is no one to invite you yet.
 */
import { hashPassword } from '@relay/auth';
import { createDatabase, users, workspaceMembers, workspaces } from '@relay/database';

const [emailArg, nameArg, passwordArg] = process.argv.slice(2);

if (!emailArg) {
  console.error('Usage: bun run scripts/grant-owner.ts <email> [name] [password]');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const name = nameArg?.trim() || email.split('@')[0]!;
const password = passwordArg ?? 'relay-demo-password';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://relay:relay@localhost:5433/relay';
const { db, close } = createDatabase(DATABASE_URL);

try {
  const passwordHash = await hashPassword(password);

  // Upsert so the script is safe to re-run; an existing account keeps its id
  // (and therefore its issues and comments) and just gets a new password.
  const [user] = await db
    .insert(users)
    .values({ email, name, passwordHash })
    .onConflictDoUpdate({ target: users.email, set: { name, passwordHash, updatedAt: new Date() } })
    .returning({ id: users.id, email: users.email, name: users.name });

  const allWorkspaces = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces);

  for (const workspace of allWorkspaces) {
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: user!.id, role: 'OWNER' })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role: 'OWNER' },
      });
  }

  console.log(
    `${user!.name} <${user!.email}> is now OWNER of ${allWorkspaces.length} workspace(s):`,
  );
  for (const workspace of allWorkspaces) console.log(`  - ${workspace.name}`);
  console.log(`\nPassword: ${password}`);
} finally {
  await close();
}
