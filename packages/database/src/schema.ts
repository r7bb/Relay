import { ISSUE_PRIORITIES, ISSUE_STATUSES, ROLES } from '@relay/shared';
import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Raw binary column. Yjs updates are an opaque byte encoding, so they are
 * stored as `bytea` rather than base64 text -- no 33% size penalty, and no
 * encode/decode on every read.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum('role', ROLES);
export const issueStatusEnum = pgEnum('issue_status', ISSUE_STATUSES);
export const issuePriorityEnum = pgEnum('issue_priority', ISSUE_PRIORITIES);

export const users = pgTable(
  'users',
  {
    id: id(),
    // Stored already-lowercased by the auth service; the unique index below is
    // on the raw column, so normalising on write is what actually prevents
    // `Ada@x.com` and `ada@x.com` becoming two accounts.
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/**
 * Opaque server-side sessions rather than stateless JWTs.
 *
 * The tradeoff is a database read per request, which is cheap and indexed. What
 * it buys is immediate revocation -- signing a user out, or kicking every
 * session after a password change -- which a self-contained JWT cannot do
 * without a denylist that reintroduces the same lookup.
 *
 * Only the SHA-256 of the token is stored, so a database leak does not hand the
 * attacker usable session cookies.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('workspaces_slug_key').on(t.slug)],
);

/**
 * The tenancy join table. Membership *is* authorization: if there is no row
 * here for (workspace, user), the user cannot see the workspace exists, and the
 * API returns 404 rather than 403 so workspace IDs aren't enumerable.
 */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('MEMBER'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_id_idx').on(t.userId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Short uppercase prefix for issue identifiers, e.g. `REL` in `REL-104`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    archived: boolean('archived').notNull().default(false),
    /**
     * Per-project issue counter. Incremented with `UPDATE ... RETURNING` inside
     * the issue-creation transaction, which takes a row lock and therefore
     * serialises concurrent creates. A shared Postgres sequence would be faster
     * but would leave gaps and is not per-project.
     */
    issueCounter: integer('issue_counter').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('projects_workspace_key_key').on(t.workspaceId, t.key),
    index('projects_workspace_id_idx').on(t.workspaceId),
  ],
);

export const issues = pgTable(
  'issues',
  {
    id: id(),
    /**
     * Denormalised from `projects`. Every tenant-scoped query filters on this
     * directly, which keeps the authorization predicate on the same table as
     * the row being read -- no join to get right, and nothing to forget.
     */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Sequential within the project; renders as `${project.key}-${number}`. */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: issueStatusEnum('status').notNull().default('TODO'),
    priority: issuePriorityEnum('priority').notNull().default('NONE'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('issues_project_number_key').on(t.projectId, t.number),
    index('issues_workspace_id_idx').on(t.workspaceId),
    index('issues_project_status_idx').on(t.projectId, t.status),
    index('issues_assignee_idx').on(t.assigneeId),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('comments_issue_id_idx').on(t.issueId, t.createdAt)],
);

/**
 * Append-only activity trail. Written in the same transaction as the mutation
 * it describes, so an event exists if and only if the change committed.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: text('payload').notNull().default(sql`'{}'`),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_workspace_created_idx').on(t.workspaceId, t.createdAt)],
);

/**
 * Collaboratively edited documents, stored as Yjs CRDT state.
 *
 * The content is not text but an opaque binary encoding of the CRDT, because
 * the merge rules live in the data structure rather than in the server. That is
 * the whole point: two people editing the same paragraph while offline both
 * keep their edit, and every replica reaches the same result regardless of the
 * order updates arrive in. Storing plain text would force the server to pick a
 * winner, which is the thing CRDTs exist to avoid.
 */
export const documents = pgTable(
  'documents',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Optional: a document can belong to the workspace rather than a project. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /**
     * Compacted CRDT state. Reading a document means this plus every row in
     * `document_updates` recorded after it.
     */
    snapshot: bytea('snapshot'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('documents_workspace_idx').on(t.workspaceId),
    index('documents_project_idx').on(t.projectId),
  ],
);

/**
 * Append-only log of CRDT updates.
 *
 * Writing a new full snapshot on every keystroke would rewrite the entire
 * document for a one-character change. Appending the update instead makes a
 * write proportional to the edit, and Yjs merges the log back into a snapshot
 * cheaply -- see `compactDocument`.
 *
 * `seq` is a bigserial rather than a timestamp: updates must be replayed in the
 * order the server accepted them, and two updates can share a millisecond.
 */
export const documentUpdates = pgTable(
  'document_updates',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('document_updates_document_seq_idx').on(t.documentId, t.seq)],
);

/**
 * Idempotency ledger.
 *
 * An offline client retries whatever is still in its queue when it reconnects,
 * and it cannot tell a request that never arrived from one whose response was
 * lost. Without this table, "create issue" retried after an ambiguous failure
 * produces two issues.
 *
 * Each mutation carries a client-generated key. The first request inserts a
 * `pending` row (the primary key is the lock), does the work, then stores its
 * response. A replay finds the row and returns the stored response instead of
 * re-applying.
 */
export const mutations = pgTable(
  'mutations',
  {
    /** Client-generated. Unique across all users; `userId` is checked too so
     * one account cannot probe or hijack another's keys. */
    key: text('key').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Hash of method + path + body. Reusing a key with a different payload is a
     * client bug, and silently returning the old response would hide it.
     */
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('pending'),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    createdAt: createdAt(),
  },
  (t) => [index('mutations_user_created_idx').on(t.userId, t.createdAt)],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMembers),
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  projects: many(projects),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  issues: many(issues),
}));

export const issuesRelations = relations(issues, ({ one, many }) => ({
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [issues.assigneeId], references: [users.id] }),
  comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  issue: one(issues, { fields: [comments.issueId], references: [issues.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Mutation = typeof mutations.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentUpdate = typeof documentUpdates.$inferSelect;
