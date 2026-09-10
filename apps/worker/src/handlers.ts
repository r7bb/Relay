import { deleteExpiredSessions } from '@relay/auth';
import {
  comments,
  type Database,
  issues,
  notifications,
  projects,
  users,
  workspaceMembers,
} from '@relay/database';
import { resolveMentions } from '@relay/shared';
import { and, eq, ne } from 'drizzle-orm';
import { scanNudges } from './nudges.ts';
import type { Handlers } from './runner.ts';

/**
 * Job handlers.
 *
 * Every one of these must be idempotent. The queue is at-least-once: a worker
 * that stalls past the visibility timeout has its job reclaimed and run again,
 * and there is no way to make delivery exactly-once without the handler's
 * cooperation.
 */

export type MentionPayload = { commentId: string };

/**
 * Notify everyone mentioned in a comment.
 *
 * Runs out of band because fan-out cost scales with the number of people
 * mentioned, and because a failure here must not roll back the comment.
 */
export const notifyMentions = async (payload: unknown, { db }: { db: Database }) => {
  const { commentId } = payload as MentionPayload;
  if (!commentId) throw new Error('notify.mentions: commentId is required');

  const [comment] = await db
    .select({
      id: comments.id,
      body: comments.body,
      authorId: comments.authorId,
      workspaceId: comments.workspaceId,
      issueId: comments.issueId,
    })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);

  // The comment was deleted between enqueue and run. Nothing to do, and
  // retrying will never help.
  if (!comment) return;

  // Only workspace members can be mentioned: resolving against all users would
  // let a comment notify someone who cannot even see the issue.
  const members = await db
    .select({ id: users.id, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, comment.workspaceId),
        // Mentioning yourself is not a notification.
        ne(workspaceMembers.userId, comment.authorId),
      ),
    );

  const mentioned = resolveMentions(comment.body, members);
  if (mentioned.length === 0) return;

  const [issue] = await db
    .select({ title: issues.title, number: issues.number, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, comment.issueId))
    .limit(1);

  const [project] = issue
    ? await db
        .select({ key: projects.key })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1)
    : [];

  await db
    .insert(notifications)
    .values(
      mentioned.map((member) => ({
        workspaceId: comment.workspaceId,
        userId: member.id,
        actorId: comment.authorId,
        kind: 'mention',
        entityType: 'comment',
        entityId: comment.id,
        // Keyed on the comment, so a redelivered job is a no-op.
        dedupeKey: `mention:${comment.id}`,
        payload: JSON.stringify({
          issueId: comment.issueId,
          issueKey: project && issue ? `${project.key}-${issue.number}` : null,
          issueTitle: issue?.title ?? null,
          excerpt: comment.body.slice(0, 140),
        }),
      })),
    )
    // Idempotency: a redelivered job must not notify twice. The unique index
    // on (user_id, dedupe_key) is what makes this a no-op.
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] });
};

/** Delete session rows that have already expired. */
export const cleanupSessions = async (_payload: unknown, { db }: { db: Database }) => {
  await deleteExpiredSessions(db);
};

/** Periodic scan that decides who could use a prompt. See `nudges.ts`. */
export const runNudgeScan = async (_payload: unknown, { db }: { db: Database }) => {
  await scanNudges(db);
};

export const handlers: Handlers = {
  'notify.mentions': notifyMentions,
  'sessions.cleanup': cleanupSessions,
  'nudges.scan': runNudgeScan,
};
