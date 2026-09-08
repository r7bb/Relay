import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  addMember,
  closeHarness,
  createActor,
  createProject,
  createWorkspace,
  request,
  resetDatabase,
} from './harness.ts';

beforeEach(resetDatabase);
afterAll(closeHarness);

describe('issue numbering', () => {
  test('numbers increment per project and render as a key', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id, 'Relay');

    const first = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'First' },
      actor: owner,
    });
    const second = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Second' },
      actor: owner,
    });

    expect(first.json().issue.number).toBe(1);
    expect(second.json().issue.number).toBe(2);
    expect(second.json().issue.key).toBe(`${project.key}-2`);
  });

  test('each project has its own counter', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const web = await createProject(owner, workspace.id, 'Web App');
    const mobile = await createProject(owner, workspace.id, 'Mobile Client');

    const webIssue = await request(`/workspaces/${workspace.id}/projects/${web.id}/issues`, {
      method: 'POST',
      payload: { title: 'Web' },
      actor: owner,
    });
    const mobileIssue = await request(`/workspaces/${workspace.id}/projects/${mobile.id}/issues`, {
      method: 'POST',
      payload: { title: 'Mobile' },
      actor: owner,
    });

    expect(webIssue.json().issue.number).toBe(1);
    expect(mobileIssue.json().issue.number).toBe(1);
    expect(web.key).not.toBe(mobile.key);
  });

  /**
   * The reason the counter is incremented with `UPDATE ... RETURNING` inside
   * the insert transaction rather than read-then-write.
   *
   * Under a read-then-write implementation this fails: several requests read
   * the same counter value and collide on `issues_project_number_key`, so some
   * requests 500 and two issues end up sharing a key.
   */
  test('concurrent creates never duplicate or skip a number', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id, 'Relay');

    const CONCURRENCY = 25;

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
          method: 'POST',
          payload: { title: `Concurrent ${i}` },
          actor: owner,
        }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(201);
    }

    const numbers = responses.map((r) => r.json().issue.number).sort((a, b) => a - b);

    // A contiguous 1..N run proves both that nothing collided and that nothing
    // was silently skipped.
    expect(numbers).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
  });
});

describe('assignment', () => {
  test('an issue can be assigned to a workspace member', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const response = await request(
      `/workspaces/${workspace.id}/projects/${project.id}/issues`,
      { method: 'POST', payload: { title: 'Assigned', assigneeId: member.id }, actor: owner },
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().issue.assigneeId).toBe(member.id);
  });

  /**
   * Without this check the assignee field would accept any uuid, letting a
   * caller confirm which user ids exist and attach outsiders to internal work.
   */
  test('an issue cannot be assigned to a non-member', async () => {
    const owner = await createActor('Owner');
    const outsider = await createActor('Outsider');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    const response = await request(
      `/workspaces/${workspace.id}/projects/${project.id}/issues`,
      { method: 'POST', payload: { title: 'Nope', assigneeId: outsider.id }, actor: owner },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad_assignee');
  });
});

describe('updates', () => {
  async function seedIssue() {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Fix OAuth refresh' },
        actor: owner,
      })
    ).json().issue;

    return { owner, workspace, project, issue };
  }

  test('a status change is accepted and recorded in the activity feed', async () => {
    const { owner, workspace, issue } = await seedIssue();

    const moved = await request(`/workspaces/${workspace.id}/issues/${issue.id}`, {
      method: 'PATCH',
      payload: { status: 'IN_PROGRESS' },
      actor: owner,
    });

    expect(moved.statusCode).toBe(200);
    expect(moved.json().issue.status).toBe('IN_PROGRESS');

    const activity = await request(`/workspaces/${workspace.id}/activity`, { actor: owner });
    const statusEvents = activity
      .json()
      .events.filter((e: { eventType: string }) => e.eventType === 'issue.status_changed');

    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].payload).toEqual({ from: 'TODO', to: 'IN_PROGRESS' });
  });

  test('an empty patch is rejected rather than silently doing nothing', async () => {
    const { owner, workspace, issue } = await seedIssue();

    const response = await request(`/workspaces/${workspace.id}/issues/${issue.id}`, {
      method: 'PATCH',
      payload: {},
      actor: owner,
    });

    expect(response.statusCode).toBe(400);
  });

  test('an unknown status is rejected', async () => {
    const { owner, workspace, issue } = await seedIssue();

    const response = await request(`/workspaces/${workspace.id}/issues/${issue.id}`, {
      method: 'PATCH',
      payload: { status: 'ALMOST_DONE' },
      actor: owner,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_failed');
  });
});

describe('cascading deletes', () => {
  test('deleting a workspace removes its projects and issues', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Doomed' },
      actor: owner,
    });

    expect(
      (await request(`/workspaces/${workspace.id}`, { method: 'DELETE', actor: owner }))
        .statusCode,
    ).toBe(204);

    // The workspace is gone, so even its former owner is now a stranger to it.
    expect((await request(`/workspaces/${workspace.id}`, { actor: owner })).statusCode).toBe(404);
    expect((await request('/workspaces', { actor: owner })).json().workspaces).toHaveLength(0);
  });

  test('deleting a project removes its issues but leaves the workspace', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Doomed' },
        actor: owner,
      })
    ).json().issue;

    await request(`/workspaces/${workspace.id}/projects/${project.id}`, {
      method: 'DELETE',
      actor: owner,
    });

    expect((await request(`/workspaces/${workspace.id}/issues/${issue.id}`, { actor: owner }))
      .statusCode).toBe(404);
    expect((await request(`/workspaces/${workspace.id}`, { actor: owner })).statusCode).toBe(200);
  });
});
