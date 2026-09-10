import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor } from '@relay/database';
import {
  type Actor,
  closeHarness,
  createActor,
  createProject,
  createWorkspace,
  request,
  resetDatabase,
} from './harness.ts';

/**
 * Keyset pagination.
 *
 * The test that matters is the concurrent-insert one. Offset paging passes
 * every other case here and fails that one, silently: it skips a row and
 * repeats another, and nothing in the response says so.
 */

beforeEach(resetDatabase);
afterAll(closeHarness);

async function seedIssues(count: number) {
  const owner = await createActor('Owner');
  const workspace = await createWorkspace(owner);
  const project = await createProject(owner, workspace.id);

  for (let i = 0; i < count; i++) {
    const response = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: `Issue ${i}` },
      actor: owner,
    });
    if (response.statusCode !== 201) throw new Error(`Seed failed: ${response.body}`);
  }

  return { owner, workspace, project };
}

async function page(
  actor: Actor,
  workspaceId: string,
  projectId: string,
  limit: number,
  cursor?: string,
) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);

  const response = await request(
    `/workspaces/${workspaceId}/projects/${projectId}/issues?${query}`,
    { actor },
  );
  return response.json() as { issues: { id: string; title: string }[]; nextCursor: string | null };
}

describe('cursor encoding', () => {
  test('round-trips the row id', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  /** A bad cursor should mean "start from the beginning", not a 500. */
  test('anything malformed decodes to null', () => {
    for (const value of [
      '',
      'not-base64!!',
      Buffer.from('nonsense').toString('base64url'),
      // A well-formed encoding of something that is not a uuid.
      Buffer.from('12345').toString('base64url'),
    ]) {
      expect(decodeCursor(value)).toBeNull();
    }
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe('paging through a list', () => {
  test('walks every row exactly once', async () => {
    const { owner, workspace, project } = await seedIssues(25);

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 10; guard++) {
      const result = await page(owner, workspace.id, project.id, 10, cursor);
      seen.push(...result.issues.map((i) => i.id));

      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  test('a short page ends the walk', async () => {
    const { owner, workspace, project } = await seedIssues(3);

    const result = await page(owner, workspace.id, project.id, 10);
    expect(result.issues).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  test('an exactly-full page still offers a cursor, and the next page is empty', async () => {
    const { owner, workspace, project } = await seedIssues(10);

    const first = await page(owner, workspace.id, project.id, 10);
    expect(first.issues).toHaveLength(10);
    // The server cannot know it is the end without looking again.
    expect(first.nextCursor).not.toBeNull();

    const second = await page(owner, workspace.id, project.id, 10, first.nextCursor!);
    expect(second.issues).toEqual([]);
    expect(second.nextCursor).toBeNull();
  });

  test('a garbage cursor returns the first page rather than an error', async () => {
    const { owner, workspace, project } = await seedIssues(5);

    const result = await page(owner, workspace.id, project.id, 10, 'total-nonsense');
    expect(result.issues).toHaveLength(5);
  });

  test('pages are ordered newest first and do not overlap', async () => {
    const { owner, workspace, project } = await seedIssues(12);

    const first = await page(owner, workspace.id, project.id, 5);
    const second = await page(owner, workspace.id, project.id, 5, first.nextCursor!);

    const firstIds = new Set(first.issues.map((i) => i.id));
    expect(second.issues.some((i) => firstIds.has(i.id))).toBe(false);

    // Newest first: the seed created "Issue 11" last.
    expect(first.issues[0]!.title).toBe('Issue 11');
  });
});

describe('stability under concurrent writes', () => {
  /**
   * The reason this is not `OFFSET`.
   *
   * With offset paging, inserting a row before page two shifts everything down
   * by one: the reader never sees the row that moved off the boundary, and
   * sees the one that moved onto it twice. A cursor names the last row read,
   * so an insert elsewhere cannot move the boundary.
   */
  test('an insert between pages neither skips nor duplicates a row', async () => {
    const { owner, workspace, project } = await seedIssues(20);

    const first = await page(owner, workspace.id, project.id, 5);
    const firstIds = first.issues.map((i) => i.id);

    // Someone else files an issue. It is newer than everything, so under
    // offset paging it would push page one's contents into page two.
    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Filed mid-read' },
      actor: owner,
    });

    const second = await page(owner, workspace.id, project.id, 5, first.nextCursor!);
    const secondIds = second.issues.map((i) => i.id);

    // No overlap...
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    // ...and nothing between the pages was stepped over.
    expect(second.issues.map((i) => i.title)).toEqual([
      'Issue 14',
      'Issue 13',
      'Issue 12',
      'Issue 11',
      'Issue 10',
    ]);
  });

  test('a deletion between pages does not skip a row either', async () => {
    const { owner, workspace, project } = await seedIssues(15);

    const first = await page(owner, workspace.id, project.id, 5);

    // Remove something from the page already read.
    await request(`/workspaces/${workspace.id}/issues/${first.issues[0]!.id}`, {
      method: 'DELETE',
      actor: owner,
    });

    const second = await page(owner, workspace.id, project.id, 5, first.nextCursor!);

    // Offset paging would shift the window back and repeat "Issue 9".
    expect(second.issues.map((i) => i.title)).toEqual([
      'Issue 9',
      'Issue 8',
      'Issue 7',
      'Issue 6',
      'Issue 5',
    ]);
  });

  /** Two issues created in the same millisecond need a deterministic order. */
  test('rows sharing a timestamp still page without repeating', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    // Created concurrently, so several will share a created_at.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
          method: 'POST',
          payload: { title: `Concurrent ${i}` },
          actor: owner,
        }),
      ),
    );

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 10; guard++) {
      const result = await page(owner, workspace.id, project.id, 4, cursor);
      seen.push(...result.issues.map((i) => i.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    // The `id` tiebreaker is what makes this exact rather than approximate.
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });
});
