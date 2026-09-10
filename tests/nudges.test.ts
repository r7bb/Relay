import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { documents, enqueue, notifications } from '@relay/database';
import { handlers } from '@relay/worker/handlers';
import { dedupeKeyFor, nudgeFor, scanNudges, weekBucket } from '@relay/worker/nudges';
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
 * Engagement nudges.
 *
 * The only failure mode that matters here is spam. Everything below is really
 * one question asked several ways: can this send the same person the same
 * prompt twice?
 */

beforeEach(resetDatabase);
afterAll(closeHarness);

async function inboxOf(actor: Actor) {
  return (await request('/notifications', { actor })).json();
}

describe('choosing a nudge', () => {
  test('a user with no workspaces is told to create one', async () => {
    const { db } = await getHarness();
    const actor = await createActor('New');

    const nudge = await nudgeFor(db, actor.id);
    expect(nudge?.kind).toBe('create_workspace');
    expect(nudge?.workspaceId).toBeNull();
  });

  test('an empty workspace is told to add a project', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Owner');
    await createWorkspace(actor);

    expect((await nudgeFor(db, actor.id))?.kind).toBe('create_project');
  });

  test('a project with no issues is told to add one', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Owner');
    const workspace = await createWorkspace(actor);
    await createProject(actor, workspace.id);

    expect((await nudgeFor(db, actor.id))?.kind).toBe('create_issue');
  });

  test('once there is work, the suggestion is documents', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Owner');
    const workspace = await createWorkspace(actor);
    const project = await createProject(actor, workspace.id);

    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Something' },
      actor,
    });

    expect((await nudgeFor(db, actor.id))?.kind).toBe('try_document');
  });

  test('a solo workspace with everything else is told to invite someone', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Owner');
    const workspace = await createWorkspace(actor);
    const project = await createProject(actor, workspace.id);

    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Something' },
      actor,
    });
    await request(`/workspaces/${workspace.id}/documents`, {
      method: 'POST',
      payload: { title: 'Notes' },
      actor,
    });

    expect((await nudgeFor(db, actor.id))?.kind).toBe('invite_teammate');
  });

  /** A fully set-up, active workspace should produce silence. */
  test('a workspace with nothing to fix produces no nudge', async () => {
    const { db } = await getHarness();
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, member, 'MEMBER');

    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Fresh work' },
      actor: owner,
    });
    await db
      .insert(documents)
      .values({ workspaceId: workspace.id, title: 'Notes', createdBy: owner.id });

    expect(await nudgeFor(db, owner.id)).toBeNull();
  });
});

describe('not being spam', () => {
  test('a scan sends at most one nudge per person', async () => {
    const { db } = await getHarness();
    const actor = await createActor('New');

    // This user trips several rules at once; only one should arrive.
    await scanNudges(db);

    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, actor.id));

    expect(rows).toHaveLength(1);
  });

  test('running the scan repeatedly in one week changes nothing', async () => {
    const { db } = await getHarness();
    const actor = await createActor('New');

    const first = await scanNudges(db);
    const second = await scanNudges(db);
    const third = await scanNudges(db);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(third).toBe(0);
    expect((await inboxOf(actor)).unreadCount).toBe(1);
  });

  /** At-least-once delivery means the scan job itself can be re-run. */
  test('redelivering the scan job does not duplicate a nudge', async () => {
    const { db } = await getHarness();
    const actor = await createActor('New');

    for (let i = 0; i < 3; i++) {
      await handlers['nudges.scan']!({}, { db });
    }

    expect((await inboxOf(actor)).notifications).toHaveLength(1);
  });

  /**
   * The point of bucketing rather than a permanent unique key: a nudge should
   * be able to come back later if the situation has not improved.
   */
  test('the same nudge can recur in a later week', async () => {
    const { db } = await getHarness();
    const actor = await createActor('New');

    const thisWeek = new Date('2026-03-02T10:00:00Z');
    const nextWeek = new Date('2026-03-10T10:00:00Z');

    expect(await scanNudges(db, thisWeek)).toBe(1);
    expect(await scanNudges(db, thisWeek)).toBe(0);
    expect(await scanNudges(db, nextWeek)).toBe(1);

    expect((await inboxOf(actor)).notifications).toHaveLength(2);
  });

  test('week buckets are stable within a week and differ across weeks', () => {
    const monday = new Date('2026-03-02T00:00:00Z');
    const friday = new Date('2026-03-06T23:00:00Z');
    const nextMonday = new Date('2026-03-09T00:00:00Z');

    expect(weekBucket(monday)).toBe(weekBucket(friday));
    expect(weekBucket(monday)).not.toBe(weekBucket(nextMonday));
    expect(weekBucket(monday)).toMatch(/^\d{4}-W\d{2}$/);
  });

  test('the dedupe key separates kind, workspace and week', () => {
    const now = new Date('2026-03-02T00:00:00Z');
    const a = dedupeKeyFor(
      { kind: 'create_project', title: '', body: '', workspaceId: 'ws-1' },
      now,
    );
    const b = dedupeKeyFor(
      { kind: 'create_project', title: '', body: '', workspaceId: 'ws-2' },
      now,
    );
    const c = dedupeKeyFor({ kind: 'try_document', title: '', body: '', workspaceId: 'ws-1' }, now);

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(
      dedupeKeyFor({ kind: 'create_project', title: '', body: '', workspaceId: 'ws-1' }, now),
    );
  });

  test('a mention and a nudge coexist without colliding', async () => {
    const { db } = await getHarness();
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Work' },
        actor: owner,
      })
    ).json().issue;

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: `@${member.email.split('@')[0]} look` },
      actor: owner,
    });

    await new Runner({ db, handlers }).tick();
    await scanNudges(db);

    const kinds = (await inboxOf(member)).notifications.map((n: { kind: string }) => n.kind);
    expect(kinds).toContain('mention');
    expect(kinds).toContain('nudge');
  });
});

describe('delivery through the queue', () => {
  test('the scan runs as a job and lands in the inbox', async () => {
    const { db } = await getHarness();
    const actor = await createActor('New');

    await enqueue(db, 'nudges.scan', {});
    const result = await new Runner({ db, handlers }).tick();

    expect(result.completed).toBe(1);

    const inbox = await inboxOf(actor);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications[0].kind).toBe('nudge');
    expect(inbox.notifications[0].payload.title).toContain('workspace');
  });

  /** A global nudge has no workspace, so the inbox must tolerate a null. */
  test('a nudge with no workspace is returned without error', async () => {
    const { db } = await getHarness();
    const actor = await createActor('New');

    await scanNudges(db);

    const [item] = (await inboxOf(actor)).notifications;
    expect(item.workspaceId).toBeNull();
    expect(item.payload.body).toBeTruthy();
  });
});

/**
 * Dismissing an inbox entry.
 *
 * A hard delete rather than a `dismissedAt` column, and the last test here is
 * why: the unique index on `(user_id, dedupe_key)` is what stops the worker
 * re-sending a nudge, so a dismissed row that stayed in the table would
 * suppress that nudge forever.
 */
describe('dismissing a notification', () => {
  async function nudgeFor_(actor: Actor) {
    await scanNudges(await harnessDb());
    const inbox = await inboxOf(actor);
    return inbox.notifications[0] as { id: string };
  }

  async function harnessDb() {
    return (await getHarness()).db;
  }

  test('removes it from the inbox', async () => {
    const actor = await createActor('Dismisser');
    const notification = await nudgeFor_(actor);

    const response = await request(`/notifications/${notification.id}`, {
      method: 'DELETE',
      actor,
    });

    expect(response.statusCode).toBe(204);
    expect((await inboxOf(actor)).notifications).toHaveLength(0);
  });

  test('someone else cannot dismiss your notification', async () => {
    const owner = await createActor('Owner');
    const stranger = await createActor('Stranger');
    const notification = await nudgeFor_(owner);

    const response = await request(`/notifications/${notification.id}`, {
      method: 'DELETE',
      actor: stranger,
    });

    // 404 rather than 403: an id you may not touch should not be confirmed.
    expect(response.statusCode).toBe(404);
    expect((await inboxOf(owner)).notifications).toHaveLength(1);
  });

  test('a malformed id is a 404 rather than a 500', async () => {
    const actor = await createActor('Dismisser');

    const response = await request('/notifications/not-a-uuid', { method: 'DELETE', actor });
    expect(response.statusCode).toBe(404);
  });

  test('dismissing twice is a 404 the second time', async () => {
    const actor = await createActor('Dismisser');
    const notification = await nudgeFor_(actor);

    const path = `/notifications/${notification.id}`;
    expect((await request(path, { method: 'DELETE', actor })).statusCode).toBe(204);
    expect((await request(path, { method: 'DELETE', actor })).statusCode).toBe(404);
  });

  /**
   * The reason dismissal deletes the row instead of flagging it. Within the
   * same week the dedupe key still applies -- dismissing is not a licence to
   * re-send immediately -- but the row is gone, so the key is free again.
   */
  test('dismissing frees the dedupe key so the nudge can return', async () => {
    const actor = await createActor('Dismisser');
    const db = await harnessDb();

    await scanNudges(db);
    const first = (await inboxOf(actor)).notifications[0];
    expect(first).toBeDefined();

    await request(`/notifications/${first.id}`, { method: 'DELETE', actor });

    const remaining = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, actor.id));

    // Nothing left holding the key.
    expect(remaining).toEqual([]);

    // So the same scan can raise it again rather than being blocked forever.
    await scanNudges(db);
    expect((await inboxOf(actor)).notifications).toHaveLength(1);
  });
});
