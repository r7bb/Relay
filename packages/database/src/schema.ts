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

/**
 * Full-text search vector.
 *
 * Declared as a stored generated column rather than maintained by a trigger or
 * by application code: Postgres recomputes it inside the same write, so it can
 * never drift from the row it describes and there is nothing to backfill after
 * a bug.
 */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

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
    /**
     * Presentation only, so it is a plain string rather than an enum: adding a
     * theme should be a code change, not a migration, and an id the client no
     * longer recognises falls back rather than failing.
     */
    theme: text('theme').notNull().default('midnight'),
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
    /** Weight A for the title, B for the body: a term in the title is a
     * stronger match than the same term buried in a description. */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('issues_project_number_key').on(t.projectId, t.number),
    index('issues_workspace_id_idx').on(t.workspaceId),
    index('issues_project_status_idx').on(t.projectId, t.status),
    index('issues_assignee_idx').on(t.assigneeId),
    index('issues_search_idx').using('gin', t.searchVector),
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
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(body, ''))`,
    ),
  },
  (t) => [
    index('comments_issue_id_idx').on(t.issueId, t.createdAt),
    index('comments_search_idx').using('gin', t.searchVector),
  ],
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
    /**
     * Plain-text mirror of the document, written by the gateway when it
     * persists. The content itself is an opaque CRDT encoding that Postgres
     * cannot read, so search needs a rendered copy -- kept alongside rather
     * than derived, because only the editor knows how to render it.
     */
    searchText: text('search_text'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(search_text, '')), 'B')`,
    ),
  },
  (t) => [
    index('documents_workspace_idx').on(t.workspaceId),
    index('documents_project_idx').on(t.projectId),
    index('documents_search_idx').using('gin', t.searchVector),
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
 * Background job queue.
 *
 * Postgres rather than Redis + BullMQ, for the same reason `NOTIFY` replaced
 * Redis pub/sub: enqueueing can join the transaction that caused it. A comment
 * insert and the notification job it schedules commit together or not at all,
 * so there is no window where the comment exists and the job was lost, or the
 * job fires for a comment that rolled back. An external broker cannot offer
 * that without an outbox table -- which is what this already is.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, so N workers take disjoint batches
 * without blocking each other or needing a coordinator.
 *
 * What Postgres does not give: this polls rather than blocking on a socket, so
 * latency is bounded by the poll interval, and throughput is bounded by the
 * database. At the point either of those hurts, a dedicated broker is the
 * answer -- but the enqueue-in-transaction guarantee is worth giving up last.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull().default(sql`'{}'`),
    /** Earliest time this may run. Backoff pushes it forward on failure. */
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /**
     * Set when a worker claims the job. A crashed worker leaves this behind,
     * so anything held past the visibility timeout is reclaimed.
     */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    /** `pending` until it exhausts its attempts, then `failed` (dead letter). */
    status: text('status').notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    // The claim query's exact predicate and ordering, so it stays an index
    // scan as the table grows.
    index('jobs_claim_idx').on(t.status, t.runAt),
  ],
);

/**
 * A thing that happened which someone should see.
 *
 * Written by a worker rather than in the request that caused it: fanning out
 * to every mentioned user inline would make posting a comment slower the more
 * people it mentions, and a failure in notification delivery would roll back
 * the comment itself.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    /** Null for notifications that are not about a workspace, such as a nudge
     * telling someone to create their first one. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Recipient. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    entityType: text('entity_type').notNull(),
    /** Null for notifications that are not about a row, such as nudges. */
    entityId: uuid('entity_id'),
    /**
     * Collision key for "do not send this twice".
     *
     * A mention uses the comment id, so redelivering the job is a no-op. A
     * nudge uses its kind plus a time bucket, so it can recur next week but
     * never twice in the same one. Encoding the rule in the value rather than
     * the index is what lets those two very different policies share one
     * constraint.
     */
    dedupeKey: text('dedupe_key').notNull(),
    payload: text('payload').notNull().default(sql`'{}'`),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Unread-first inbox for one user, which is the only way this is read.
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    uniqueIndex('notifications_dedupe_key').on(t.userId, t.dedupeKey),
  ],
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
export type Job = typeof jobs.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentUpdate = typeof documentUpdates.$inferSelect;
