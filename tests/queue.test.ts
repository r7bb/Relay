import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  backoffMs,
  claimJobs,
  completeJob,
  deadLetterCount,
  enqueue,
  failJob,
  jobs,
  notifications,
  pendingCount,
  VISIBILITY_TIMEOUT_MS,
} from '@relay/database';
import { handlers } from '@relay/worker/handlers';
import { Runner } from '@relay/worker/runner';
import { eq } from 'drizzle-orm';
import {
  type Actor,
  addMember,
  closeHarness,
  createActor,
  createProject,
  createWorkspace,
  getHarness,
  request,
  resetDatabase,
} from './harness.ts';

/**
 * The job queue, against a real Postgres.
 *
 * `SKIP LOCKED` is the whole design, and it is a database behaviour -- a mock
 * would only prove the mock skips locked rows. Same for the transactional
 * enqueue: the guarantee is that the job and the write that caused it commit
 * together, which is not observable without a real transaction.
 */

beforeEach(resetDatabase);
afterAll(closeHarness);

describe('claiming', () => {
  test('a claimed job is not handed to a second worker', async () => {
    const { db } = await getHarness();
    await enqueue(db, 'test.noop', { n: 1 });

    const first = await claimJobs(db, 'worker-a');
    const second = await claimJobs(db, 'worker-b');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  /**
   * The property `SKIP LOCKED` exists for: many workers pulling at once must
   * partition the queue, never overlap it.
   */
  test('concurrent workers take disjoint batches with no duplicates', async () => {
    const { db } = await getHarness();

    const total = 40;
    for (let i = 0; i < total; i++) await enqueue(db, 'test.noop', { i });

    const batches = await Promise.all(
      Array.from({ length: 6 }, (_, index) => claimJobs(db, `worker-${index}`, 10)),
    );

    const claimed = batches.flat().map((job) => job.id);

    // Every job claimed exactly once...
    expect(new Set(claimed).size).toBe(claimed.length);
    // ...and nothing was skipped: six workers at ten each covers forty.
    expect(claimed).toHaveLength(total);
    expect(await pendingCount(db)).toBe(0);
  });

  test('a job scheduled for later is not claimed yet', async () => {
    const { db } = await getHarness();
    await enqueue(db, 'test.noop', {}, { delayMs: 60_000 });

    expect(await claimJobs(db, 'worker-a')).toHaveLength(0);

    // ...but is once its time arrives.
    const later = new Date(Date.now() + 61_000);
    expect(await claimJobs(db, 'worker-a', 5, later)).toHaveLength(1);
  });

  test('jobs are claimed oldest-due first', async () => {
    const { db } = await getHarness();

    await enqueue(db, 'test.third', {}, { delayMs: 2 });
    await enqueue(db, 'test.first', {}, { delayMs: -2000 });
    await enqueue(db, 'test.second', {}, { delayMs: -1000 });

    const claimed = await claimJobs(db, 'worker-a', 3, new Date(Date.now() + 10));
    expect(claimed.map((job) => job.kind)).toEqual(['test.first', 'test.second', 'test.third']);
  });

  /** A worker that dies mid-job must not strand it forever. */
  test('a job held past the visibility timeout is reclaimed', async () => {
    const { db } = await getHarness();
    await enqueue(db, 'test.noop', {});

    const [claimed] = await claimJobs(db, 'crashed-worker');
    expect(claimed).toBeDefined();

    // Nothing available while the lock is fresh.
    expect(await claimJobs(db, 'worker-b')).toHaveLength(0);

    const afterTimeout = new Date(Date.now() + VISIBILITY_TIMEOUT_MS + 1000);
    const reclaimed = await claimJobs(db, 'worker-b', 5, afterTimeout);

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.id).toBe(claimed!.id);
    // The retry counts as another attempt.
    expect(reclaimed[0]!.attempts).toBe(2);
  });
});

describe('completion and failure', () => {
  test('a completed job leaves the queue', async () => {
    const { db } = await getHarness();
    await enqueue(db, 'test.noop', {});

    const [job] = await claimJobs(db, 'worker-a');
    await completeJob(db, job!.id);

    expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);
  });

  test('a failure reschedules with backoff', async () => {
    const { db } = await getHarness();
    await enqueue(db, 'test.flaky', {});

    const [job] = await claimJobs(db, 'worker-a');
    const outcome = await failJob(db, job!, new Error('boom'));

    expect(outcome).toBe('retrying');

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row!.status).toBe('pending');
    expect(row!.lastError).toContain('boom');
    expect(row!.lockedAt).toBeNull();
    // Pushed into the future, so it is not immediately re-claimable.
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(await claimJobs(db, 'worker-b')).toHaveLength(0);
  });

  test('backoff grows and is capped', () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(100)).toBe(60 * 60 * 1000);
  });

  test('a job that exhausts its attempts is dead-lettered, not retried forever', async () => {
    const { db } = await getHarness();
    await enqueue(db, 'test.doomed', {}, { maxAttempts: 2 });

    let outcome: string | undefined;
    for (let i = 0; i < 2; i++) {
      const [job] = await claimJobs(db, 'worker-a', 5, new Date(Date.now() + i * 120_000));
      outcome = await failJob(db, job!, new Error('always fails'));
    }

    expect(outcome).toBe('dead');
    expect(await deadLetterCount(db)).toBe(1);

    // Dead jobs stay out of the working set, however far in the future we look.
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(await claimJobs(db, 'worker-b', 5, farFuture)).toHaveLength(0);
  });
});

describe('the runner', () => {
  const noopHandlers = {
    'test.ok': async () => {},
    'test.boom': async () => {
      throw new Error('handler exploded');
    },
  };

  test('processes a batch and reports what happened', async () => {
    const { db } = await getHarness();
    for (let i = 0; i < 3; i++) await enqueue(db, 'test.ok', { i });
    await enqueue(db, 'test.boom', {});

    const runner = new Runner({ db, handlers: noopHandlers });
    const result = await runner.tick();

    expect(result.claimed).toBe(4);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(1);
  });

  test('an empty queue is a no-op', async () => {
    const { db } = await getHarness();
    const runner = new Runner({ db, handlers: noopHandlers });

    expect(await runner.tick()).toEqual({ claimed: 0, completed: 0, failed: 0, dead: 0 });
  });

  /**
   * An unknown kind means the queue is ahead of the deployed code. Retrying
   * cannot help, and burning the attempt budget just delays the signal.
   */
  test('a job with no handler is dead-lettered immediately', async () => {
    const { db } = await getHarness();
    await enqueue(db, 'test.unknown', {});

    const runner = new Runner({ db, handlers: noopHandlers });
    const result = await runner.tick();

    expect(result.dead).toBe(1);
    expect(await deadLetterCount(db)).toBe(1);

    const [row] = await db.select().from(jobs);
    expect(row!.lastError).toContain('No handler');
  });
});

describe('mention notifications end to end', () => {
  async function setup() {
    const owner = await createActor('Owner');
    const mentioned = await createActor('Mentioned');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, mentioned, 'MEMBER');

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Needs a look' },
        actor: owner,
      })
    ).json().issue;

    return { owner, mentioned, workspace, issue };
  }

  const handleOf = (actor: Actor) => actor.email.split('@')[0];

  test('commenting enqueues a job in the same transaction', async () => {
    const { db } = await getHarness();
    const { owner, mentioned, workspace, issue } = await setup();

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: `@${handleOf(mentioned)} please review` },
      actor: owner,
    });

    const queued = await db.select().from(jobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe('notify.mentions');
  });

  test('the worker turns the job into a notification', async () => {
    const { db } = await getHarness();
    const { owner, mentioned, workspace, issue } = await setup();

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: `@${handleOf(mentioned)} can you take this?` },
      actor: owner,
    });

    await new Runner({ db, handlers }).tick();

    const inbox = await request('/notifications', { actor: mentioned });
    expect(inbox.json().unreadCount).toBe(1);

    const [notification] = inbox.json().notifications;
    expect(notification.kind).toBe('mention');
    expect(notification.actorName).toBe('Owner');
    expect(notification.payload.excerpt).toContain('can you take this?');
  });

  /** At-least-once delivery means the handler must tolerate rerunning. */
  test('rerunning the job does not duplicate the notification', async () => {
    const { db } = await getHarness();
    const { owner, mentioned, workspace, issue } = await setup();

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: `@${handleOf(mentioned)} hello` },
      actor: owner,
    });

    // Run the handler three times against the same comment.
    const [job] = await db.select().from(jobs);
    for (let i = 0; i < 3; i++) {
      await handlers['notify.mentions']!({ commentId: JSON.parse(job!.payload).commentId }, { db });
    }

    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, mentioned.id));

    expect(rows).toHaveLength(1);
  });

  test('mentioning yourself notifies nobody', async () => {
    const { db } = await getHarness();
    const { owner, workspace, issue } = await setup();

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: `note to self @${handleOf(owner)}` },
      actor: owner,
    });

    await new Runner({ db, handlers }).tick();

    expect((await request('/notifications', { actor: owner })).json().unreadCount).toBe(0);
  });

  /** Mentioning an outsider must not tell them about work they cannot see. */
  test('a non-member cannot be mentioned into a workspace', async () => {
    const { db } = await getHarness();
    const { owner, workspace, issue } = await setup();
    const outsider = await createActor('Outsider');

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: `@${handleOf(outsider)} look at this` },
      actor: owner,
    });

    await new Runner({ db, handlers }).tick();

    expect((await request('/notifications', { actor: outsider })).json().unreadCount).toBe(0);
  });

  test('a deleted comment makes the job a no-op rather than a failure', async () => {
    const { db } = await getHarness();
    const { owner, mentioned, workspace, issue } = await setup();

    const comment = (
      await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
        method: 'POST',
        payload: { body: `@${handleOf(mentioned)} oops` },
        actor: owner,
      })
    ).json().comment;

    await request(`/workspaces/${workspace.id}/comments/${comment.id}`, {
      method: 'DELETE',
      actor: owner,
    });

    const result = await new Runner({ db, handlers }).tick();

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe('the inbox', () => {
  test('marking one read leaves the others alone', async () => {
    const { db } = await getHarness();
    const owner = await createActor('Owner');
    const reader = await createActor('Reader');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, reader, 'MEMBER');

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Thread' },
        actor: owner,
      })
    ).json().issue;

    const handle = reader.email.split('@')[0];
    for (const body of [`@${handle} one`, `@${handle} two`]) {
      await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
        method: 'POST',
        payload: { body },
        actor: owner,
      });
    }
    await new Runner({ db, handlers }).tick();

    const before = await request('/notifications', { actor: reader });
    expect(before.json().unreadCount).toBe(2);

    const [first] = before.json().notifications;
    await request(`/notifications/${first.id}/read`, { method: 'POST', actor: reader });

    expect((await request('/notifications', { actor: reader })).json().unreadCount).toBe(1);

    await request('/notifications/read-all', { method: 'POST', actor: reader });
    expect((await request('/notifications', { actor: reader })).json().unreadCount).toBe(0);
  });

  /** The inbox is scoped by recipient, and that is the whole tenant boundary. */
  test('you cannot read or mark someone else notification', async () => {
    const { db } = await getHarness();
    const owner = await createActor('Owner');
    const reader = await createActor('Reader');
    const stranger = await createActor('Stranger');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, reader, 'MEMBER');

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Private' },
        actor: owner,
      })
    ).json().issue;

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: `@${reader.email.split('@')[0]} secret` },
      actor: owner,
    });
    await new Runner({ db, handlers }).tick();

    const [notification] = (await request('/notifications', { actor: reader })).json()
      .notifications;

    // The stranger sees an empty inbox...
    expect((await request('/notifications', { actor: stranger })).json().notifications).toEqual([]);

    // ...and cannot mark a notification they do not own, even with its id.
    const stolen = await request(`/notifications/${notification.id}/read`, {
      method: 'POST',
      actor: stranger,
    });
    expect(stolen.statusCode).toBe(404);
  });

  test('the inbox requires a session', async () => {
    expect((await request('/notifications')).statusCode).toBe(401);
  });
});
