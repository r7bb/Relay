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

describe('tenant isolation', () => {
  /**
   * The scenario the whole authorization model exists to stop: someone with a
   * valid account pasting another tenant's id into a URL.
   */
  test('a stranger gets 404, not 403, for a workspace they do not belong to', async () => {
    const owner = await createActor('Owner');
    const stranger = await createActor('Stranger');
    const workspace = await createWorkspace(owner);

    const response = await request(`/workspaces/${workspace.id}`, { actor: stranger });

    // 403 would confirm the workspace exists and make ids enumerable.
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');
  });

  test('a stranger cannot list another workspace projects or issues', async () => {
    const owner = await createActor('Owner');
    const stranger = await createActor('Stranger');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    for (const url of [
      `/workspaces/${workspace.id}/projects`,
      `/workspaces/${workspace.id}/projects/${project.id}/issues`,
      `/workspaces/${workspace.id}/members`,
      `/workspaces/${workspace.id}/activity`,
    ]) {
      expect((await request(url, { actor: stranger })).statusCode).toBe(404);
    }
  });

  /**
   * Membership of workspace A must not grant access to a resource in B, even
   * though the caller is a legitimate member of the workspace in the path.
   */
  test('a project id from another workspace is not reachable through your own', async () => {
    const alice = await createActor('Alice');
    const bob = await createActor('Bob');

    const alphaWorkspace = await createWorkspace(alice, 'Alpha');
    const betaWorkspace = await createWorkspace(bob, 'Beta');
    const betaProject = await createProject(bob, betaWorkspace.id);

    const response = await request(`/workspaces/${alphaWorkspace.id}/projects/${betaProject.id}`, {
      actor: alice,
    });

    expect(response.statusCode).toBe(404);
  });

  test('an issue id from another workspace is not reachable through your own', async () => {
    const alice = await createActor('Alice');
    const bob = await createActor('Bob');

    const alphaWorkspace = await createWorkspace(alice, 'Alpha');
    const betaWorkspace = await createWorkspace(bob, 'Beta');
    const betaProject = await createProject(bob, betaWorkspace.id);

    const created = await request(
      `/workspaces/${betaWorkspace.id}/projects/${betaProject.id}/issues`,
      { method: 'POST', payload: { title: 'Beta secret' }, actor: bob },
    );
    const issueId = created.json().issue.id;

    const read = await request(`/workspaces/${alphaWorkspace.id}/issues/${issueId}`, {
      actor: alice,
    });
    expect(read.statusCode).toBe(404);

    const write = await request(`/workspaces/${alphaWorkspace.id}/issues/${issueId}`, {
      method: 'PATCH',
      payload: { title: 'Defaced' },
      actor: alice,
    });
    expect(write.statusCode).toBe(404);
  });

  test('a malformed workspace id is a 404, not a 500', async () => {
    const actor = await createActor('Alice');

    const response = await request('/workspaces/not-a-uuid', { actor });

    expect(response.statusCode).toBe(404);
  });

  test('unauthenticated requests are rejected before any lookup', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);

    const response = await request(`/workspaces/${workspace.id}`);

    expect(response.statusCode).toBe(401);
  });
});

describe('role boundaries', () => {
  test('a guest can read issues but not create them', async () => {
    const owner = await createActor('Owner');
    const guest = await createActor('Guest');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, guest, 'GUEST');

    const read = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      actor: guest,
    });
    expect(read.statusCode).toBe(200);

    const write = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Nope' },
      actor: guest,
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe('forbidden');
  });

  test('a member can manage issues but cannot invite people', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const outsider = await createActor('Outsider');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const created = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Fix OAuth' },
      actor: member,
    });
    expect(created.statusCode).toBe(201);

    const invite = await request(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      payload: { email: outsider.email, role: 'MEMBER' },
      actor: member,
    });
    expect(invite.statusCode).toBe(403);
  });

  test('only an owner can delete the workspace', async () => {
    const owner = await createActor('Owner');
    const admin = await createActor('Admin');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, admin, 'ADMIN');

    const byAdmin = await request(`/workspaces/${workspace.id}`, {
      method: 'DELETE',
      actor: admin,
    });
    expect(byAdmin.statusCode).toBe(403);

    const byOwner = await request(`/workspaces/${workspace.id}`, {
      method: 'DELETE',
      actor: owner,
    });
    expect(byOwner.statusCode).toBe(204);
  });
});

describe('privilege escalation', () => {
  test('an admin cannot promote anyone to owner', async () => {
    const owner = await createActor('Owner');
    const admin = await createActor('Admin');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, admin, 'ADMIN');
    await addMember(owner, workspace.id, member, 'MEMBER');

    const response = await request(`/workspaces/${workspace.id}/members/${member.id}`, {
      method: 'PATCH',
      payload: { role: 'OWNER' },
      actor: admin,
    });

    expect(response.statusCode).toBe(403);
  });

  test('an admin cannot invite someone as owner', async () => {
    const owner = await createActor('Owner');
    const admin = await createActor('Admin');
    const outsider = await createActor('Outsider');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, admin, 'ADMIN');

    const response = await request(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      payload: { email: outsider.email, role: 'OWNER' },
      actor: admin,
    });

    expect(response.statusCode).toBe(403);
  });

  test('an admin cannot demote or remove an owner', async () => {
    const owner = await createActor('Owner');
    const secondOwner = await createActor('Second Owner');
    const admin = await createActor('Admin');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, secondOwner, 'OWNER');
    await addMember(owner, workspace.id, admin, 'ADMIN');

    const demote = await request(`/workspaces/${workspace.id}/members/${secondOwner.id}`, {
      method: 'PATCH',
      payload: { role: 'MEMBER' },
      actor: admin,
    });
    expect(demote.statusCode).toBe(403);

    const remove = await request(`/workspaces/${workspace.id}/members/${secondOwner.id}`, {
      method: 'DELETE',
      actor: admin,
    });
    expect(remove.statusCode).toBe(403);
  });

  test('nobody can change their own role', async () => {
    const owner = await createActor('Owner');
    const admin = await createActor('Admin');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, admin, 'ADMIN');

    const response = await request(`/workspaces/${workspace.id}/members/${admin.id}`, {
      method: 'PATCH',
      payload: { role: 'OWNER' },
      actor: admin,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('last owner protection', () => {
  test('the only owner cannot be demoted', async () => {
    const owner = await createActor('Owner');
    const other = await createActor('Other Owner');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, other, 'OWNER');

    // Two owners: demoting one is fine.
    const first = await request(`/workspaces/${workspace.id}/members/${other.id}`, {
      method: 'PATCH',
      payload: { role: 'ADMIN' },
      actor: owner,
    });
    expect(first.statusCode).toBe(200);

    // One owner left, and they cannot demote themselves either.
    const second = await request(`/workspaces/${workspace.id}/members/${owner.id}`, {
      method: 'PATCH',
      payload: { role: 'ADMIN' },
      actor: owner,
    });
    expect(second.statusCode).toBe(403);
  });

  test('the only owner cannot leave the workspace', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);

    const response = await request(`/workspaces/${workspace.id}/members/me`, {
      method: 'DELETE',
      actor: owner,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('last_owner');
  });

  test('a member can leave freely', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const left = await request(`/workspaces/${workspace.id}/members/me`, {
      method: 'DELETE',
      actor: member,
    });
    expect(left.statusCode).toBe(204);

    // Access is gone immediately.
    expect((await request(`/workspaces/${workspace.id}`, { actor: member })).statusCode).toBe(404);
  });
});

describe('comment moderation', () => {
  async function setup() {
    const owner = await createActor('Owner');
    const author = await createActor('Author');
    const bystander = await createActor('Bystander');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, author, 'MEMBER');
    await addMember(owner, workspace.id, bystander, 'MEMBER');

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Discuss' },
        actor: owner,
      })
    ).json().issue;

    const comment = (
      await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
        method: 'POST',
        payload: { body: 'Reproduced on Safari' },
        actor: author,
      })
    ).json().comment;

    return { owner, author, bystander, workspace, comment };
  }

  test('an author can delete their own comment', async () => {
    const { author, workspace, comment } = await setup();

    const response = await request(`/workspaces/${workspace.id}/comments/${comment.id}`, {
      method: 'DELETE',
      actor: author,
    });

    expect(response.statusCode).toBe(204);
  });

  test('a peer member cannot delete someone else comment', async () => {
    const { bystander, workspace, comment } = await setup();

    const response = await request(`/workspaces/${workspace.id}/comments/${comment.id}`, {
      method: 'DELETE',
      actor: bystander,
    });

    expect(response.statusCode).toBe(403);
  });

  test('an owner can moderate any comment', async () => {
    const { owner, workspace, comment } = await setup();

    const response = await request(`/workspaces/${workspace.id}/comments/${comment.id}`, {
      method: 'DELETE',
      actor: owner,
    });

    expect(response.statusCode).toBe(204);
  });
});
