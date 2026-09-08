/**
 * Populate the dev database with a workspace you can actually click through.
 *
 * Idempotent: re-running wipes the seeded rows first, so it is safe to use as a
 * "put things back how they were" button during development.
 *
 *   bun run db:seed           just the owner account
 *   bun run db:seed --team    plus four teammates, for multi-user demos
 *
 * The default is a single account. The `--team` roster exists because presence,
 * live collaboration and the role model are only observable with more than one
 * person -- there is nothing to see in a permission matrix when every session is
 * the same owner.
 */
import { hashPassword } from '@relay/auth';
import {
  createDatabase,
  issues,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from '@relay/database';
import { type IssuePriority, type IssueStatus, type Role, slugify } from '@relay/shared';
import { eq, inArray } from 'drizzle-orm';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://relay:relay@localhost:5433/relay';
const PASSWORD = process.env.SEED_PASSWORD ?? 'relay-demo-password';

const WITH_TEAM = process.argv.includes('--team');

type Person = { email: string; name: string; role: Role };

const OWNER: Person = { email: 'rohit@relay.dev', name: 'Rohit Biju', role: 'OWNER' };

/** Only created with `--team`. */
const TEAM: Person[] = [
  { email: 'alex@relay.dev', name: 'Alex Rivera', role: 'ADMIN' },
  { email: 'john@relay.dev', name: 'John Okafor', role: 'MEMBER' },
  { email: 'mia@relay.dev', name: 'Mia Lindqvist', role: 'GUEST' },
];

const PEOPLE: Person[] = WITH_TEAM ? [OWNER, ...TEAM] : [OWNER];

type IssueSpec = {
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  /** Only honoured when that person exists; otherwise the issue is unassigned. */
  assignee?: string;
};

const PROJECTS: { key: string; name: string; description: string; issues: IssueSpec[] }[] = [
  {
    key: 'REL',
    name: 'Web App',
    description: 'The Relay client.',
    issues: [
      {
        title: 'Fix OAuth refresh-token bug',
        status: 'TODO',
        priority: 'URGENT',
        assignee: OWNER.email,
      },
      { title: 'Reproduce Safari authentication issue', status: 'TODO', priority: 'HIGH' },
      {
        title: 'Search across issues and documents',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        assignee: OWNER.email,
      },
      { title: 'Keyboard shortcuts for the board', status: 'IN_PROGRESS', priority: 'LOW' },
      {
        title: 'Billing settings page',
        status: 'IN_REVIEW',
        priority: 'MEDIUM',
        assignee: 'alex@relay.dev',
      },
      { title: 'Dark mode', status: 'DONE', priority: 'LOW', assignee: OWNER.email },
    ],
  },
  {
    key: 'API',
    name: 'Backend',
    description: 'Fastify service and Postgres schema.',
    issues: [
      {
        title: 'Rate limit the auth endpoints',
        status: 'TODO',
        priority: 'HIGH',
        assignee: OWNER.email,
      },
      { title: 'Audit log retention policy', status: 'TODO', priority: 'NONE' },
      {
        title: 'Cursor pagination for issue lists',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        assignee: 'john@relay.dev',
      },
      { title: 'Session cleanup job', status: 'DONE', priority: 'LOW' },
    ],
  },
];

const WORKSPACE_NAME = 'Engineering';

const { db, close } = createDatabase(DATABASE_URL);

try {
  // Clear every account this script can create, not just the ones it is about
  // to create, so switching between solo and --team leaves nothing behind.
  const seedEmails = [OWNER, ...TEAM].map((person) => person.email);

  // Workspaces cascade to projects and issues; users are deleted after, because
  // `created_by` is ON DELETE RESTRICT.
  await db.delete(workspaces).where(eq(workspaces.slug, slugify(WORKSPACE_NAME)));
  await db.delete(users).where(inArray(users.email, seedEmails));

  const passwordHash = await hashPassword(PASSWORD);

  const createdUsers = await db
    .insert(users)
    .values(PEOPLE.map((person) => ({ email: person.email, name: person.name, passwordHash })))
    .returning({ id: users.id, email: users.email });

  const userIdByEmail = new Map(createdUsers.map((user) => [user.email, user.id]));
  const ownerId = userIdByEmail.get(OWNER.email)!;

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: WORKSPACE_NAME, slug: slugify(WORKSPACE_NAME), createdBy: ownerId })
    .returning();

  await db.insert(workspaceMembers).values(
    PEOPLE.map((person) => ({
      workspaceId: workspace!.id,
      userId: userIdByEmail.get(person.email)!,
      role: person.role,
    })),
  );

  let issueCount = 0;

  for (const spec of PROJECTS) {
    const [project] = await db
      .insert(projects)
      .values({
        workspaceId: workspace!.id,
        key: spec.key,
        name: spec.name,
        description: spec.description,
        issueCounter: spec.issues.length,
        createdBy: ownerId,
      })
      .returning();

    await db.insert(issues).values(
      spec.issues.map((issue, index) => ({
        workspaceId: workspace!.id,
        projectId: project!.id,
        number: index + 1,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        // Falls back to unassigned when seeding solo and the named teammate
        // does not exist.
        assigneeId: (issue.assignee && userIdByEmail.get(issue.assignee)) ?? null,
        createdBy: ownerId,
      })),
    );

    issueCount += spec.issues.length;
  }

  const who = WITH_TEAM ? `${PEOPLE.length} users` : '1 user';
  console.log(
    `Seeded "${WORKSPACE_NAME}": ${who}, ${PROJECTS.length} projects, ${issueCount} issues.`,
  );
  console.log(`Sign in as ${OWNER.email} with password "${PASSWORD}".`);

  if (!WITH_TEAM) {
    console.log('Run with --team to add teammates for presence and role demos.');
  }
} finally {
  await close();
}
