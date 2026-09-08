/**
 * Populate the dev database with a workspace you can actually click through.
 *
 * Idempotent: re-running wipes the seeded rows first, so it is safe to use as a
 * "put things back how they were" button during development.
 *
 *   bun run db:seed
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

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://relay:relay@localhost:5433/relay';
const PASSWORD = 'relay-demo-password';

const PEOPLE: { email: string; name: string; role: Role }[] = [
  { email: 'rohit@relay.dev', name: 'Rohit Biju', role: 'OWNER' },
  { email: 'sarah@relay.dev', name: 'Sarah Chen', role: 'OWNER' },
  { email: 'alex@relay.dev', name: 'Alex Rivera', role: 'ADMIN' },
  { email: 'john@relay.dev', name: 'John Okafor', role: 'MEMBER' },
  { email: 'mia@relay.dev', name: 'Mia Lindqvist', role: 'GUEST' },
];

const PROJECTS: {
  key: string;
  name: string;
  description: string;
  issues: { title: string; status: IssueStatus; priority: IssuePriority; assignee?: string }[];
}[] = [
  {
    key: 'REL',
    name: 'Web App',
    description: 'The Relay client.',
    issues: [
      { title: 'Fix OAuth refresh-token bug', status: 'TODO', priority: 'URGENT', assignee: 'alex@relay.dev' },
      { title: 'Reproduce Safari authentication issue', status: 'TODO', priority: 'HIGH', assignee: 'john@relay.dev' },
      { title: 'Search across issues and documents', status: 'IN_PROGRESS', priority: 'MEDIUM', assignee: 'sarah@relay.dev' },
      { title: 'Keyboard shortcuts for the board', status: 'IN_PROGRESS', priority: 'LOW' },
      { title: 'Billing settings page', status: 'IN_REVIEW', priority: 'MEDIUM', assignee: 'alex@relay.dev' },
      { title: 'Dark mode', status: 'DONE', priority: 'LOW', assignee: 'sarah@relay.dev' },
    ],
  },
  {
    key: 'API',
    name: 'Backend',
    description: 'Fastify service and Postgres schema.',
    issues: [
      { title: 'Rate limit the auth endpoints', status: 'TODO', priority: 'HIGH', assignee: 'sarah@relay.dev' },
      { title: 'Audit log retention policy', status: 'TODO', priority: 'NONE' },
      { title: 'Cursor pagination for issue lists', status: 'IN_PROGRESS', priority: 'MEDIUM', assignee: 'john@relay.dev' },
      { title: 'Session cleanup job', status: 'DONE', priority: 'LOW' },
    ],
  },
];

const WORKSPACE_NAME = 'Engineering';

const { db, close } = createDatabase(DATABASE_URL);

try {
  const emails = PEOPLE.map((p) => p.email);

  // Remove any previous seed. Workspaces cascade to projects and issues; users
  // are deleted last because `created_by` is ON DELETE RESTRICT.
  await db.delete(workspaces).where(eq(workspaces.slug, slugify(WORKSPACE_NAME)));
  await db.delete(users).where(inArray(users.email, emails));

  const passwordHash = await hashPassword(PASSWORD);

  const createdUsers = await db
    .insert(users)
    .values(PEOPLE.map((p) => ({ email: p.email, name: p.name, passwordHash })))
    .returning({ id: users.id, email: users.email });

  const userIdByEmail = new Map(createdUsers.map((u) => [u.email, u.id]));
  const ownerId = userIdByEmail.get('sarah@relay.dev')!;

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: WORKSPACE_NAME, slug: slugify(WORKSPACE_NAME), createdBy: ownerId })
    .returning();

  await db.insert(workspaceMembers).values(
    PEOPLE.map((p) => ({
      workspaceId: workspace!.id,
      userId: userIdByEmail.get(p.email)!,
      role: p.role,
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
        assigneeId: issue.assignee ? userIdByEmail.get(issue.assignee)! : null,
        createdBy: ownerId,
      })),
    );

    issueCount += spec.issues.length;
  }

  console.log(`Seeded "${WORKSPACE_NAME}": ${PEOPLE.length} users, ${PROJECTS.length} projects, ${issueCount} issues.`);
  console.log(`Sign in as any of ${emails.join(', ')} with password "${PASSWORD}".`);
} finally {
  await close();
}
