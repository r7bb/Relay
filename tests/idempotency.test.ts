import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeHarness,
  createActor,
  createProject,
  createWorkspace,
  request,
  resetDatabase,
} from './harness.ts';

/**
 * Server-side idempotency, against a real Postgres.
 *
 * The sync-engine tests prove the client resends a stable key; these prove the
 * server does the right thing when it arrives twice. Both halves are needed --
 * exactly-once delivery is a property of the pair, not of either side.
 */

beforeEach(resetDatabase);
afterAll(closeHarness);

async function setup() {
  const owner = await createActor('Owner');
  const workspace = await createWorkspace(owner);
  const project = await createProject(owner, workspace.id);
  return { owner, workspace, project };
}

const KEY = '11111111-2222-4333-8444-555555555555';

describe('replayed mutations', () => {
  test('the same key applied twice creates exactly one issue', async () => {
    const { owner, workspace, project } = await setup();
    const url = `/workspaces/${workspace.id}/projects/${project.id}/issues`;
    const payload = { title: 'Created once' };

    const first = await request(url, {
      method: 'POST',
      payload,
      actor: owner,
      headers: { 'idempotency-key': KEY },
    });

    const second = await request(url, {
      method: 'POST',
      payload,
      actor: owner,
      headers: { 'idempotency-key': KEY },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    // Identical response, and flagged as a replay rather than fresh work.
    expect(second.json().issue.id).toBe(first.json().issue.id);
    expect(second.headers['idempotent-replay']).toBe('true');

    const list = await request(url, { actor: owner });
    expect(list.json().issues).toHaveLength(1);
  });

  test('the issue number is not consumed twice by a replay', async () => {
    const { owner, workspace, project } = await setup();
    const url = `/workspaces/${workspace.id}/projects/${project.id}/issues`;

    for (let i = 0; i < 3; i++) {
      await request(url, {
        method: 'POST',
        payload: { title: 'Replayed' },
        actor: owner,
        headers: { 'idempotency-key': KEY },
      });
    }

    // A later, distinct create must still get number 2 -- the replays did not
    // advance the counter.
    const next = await request(url, {
      method: 'POST',
      payload: { title: 'Second real issue' },
      actor: owner,
    });

    expect(next.json().issue.number).toBe(2);
  });

  test('concurrent replays of one key still produce one issue', async () => {
    const { owner, workspace, project } = await setup();
    const url = `/workspaces/${workspace.id}/projects/${project.id}/issues`;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(url, {
          method: 'POST',
          payload: { title: 'Racing' },
          actor: owner,
          headers: { 'idempotency-key': KEY },
        }),
      ),
    );

    // Every caller either did the work or got the winner's answer; none 500s.
    for (const response of responses) {
      expect([201, 409]).toContain(response.statusCode);
    }

    const list = await request(url, { actor: owner });
    expect(list.json().issues).toHaveLength(1);
  });
});

describe('key misuse', () => {
  test('reusing a key with a different body is rejected', async () => {
    const { owner, workspace, project } = await setup();
    const url = `/workspaces/${workspace.id}/projects/${project.id}/issues`;

    await request(url, {
      method: 'POST',
      payload: { title: 'Original' },
      actor: owner,
      headers: { 'idempotency-key': KEY },
    });

    const mismatched = await request(url, {
      method: 'POST',
      payload: { title: 'Something else entirely' },
      actor: owner,
      headers: { 'idempotency-key': KEY },
    });

    // Silently returning the first response would hide a real client bug.
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json().error).toBe('idempotency_mismatch');
  });

  /** Keys are client-chosen, so one account must not be able to probe or
   * hijack another's. */
  test('another user cannot reuse or probe your key', async () => {
    const { owner, workspace, project } = await setup();
    const other = await createActor('Other');
    const otherWorkspace = await createWorkspace(other, 'Other Space');
    const otherProject = await createProject(other, otherWorkspace.id);

    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Mine' },
      actor: owner,
      headers: { 'idempotency-key': KEY },
    });

    const stolen = await request(
      `/workspaces/${otherWorkspace.id}/projects/${otherProject.id}/issues`,
      {
        method: 'POST',
        payload: { title: 'Theirs' },
        actor: other,
        headers: { 'idempotency-key': KEY },
      },
    );

    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().error).toBe('idempotency_conflict');
  });

  /** A transient failure must not burn the key permanently. */
  test('a failed request releases its key for a genuine retry', async () => {
    const { owner, workspace, project } = await setup();
    const url = `/workspaces/${workspace.id}/projects/${project.id}/issues`;

    const rejected = await request(url, {
      method: 'POST',
      payload: { title: '' }, // fails validation
      actor: owner,
      headers: { 'idempotency-key': KEY },
    });
    expect(rejected.statusCode).toBe(400);

    const retried = await request(url, {
      method: 'POST',
      payload: { title: 'Fixed' },
      actor: owner,
      headers: { 'idempotency-key': KEY },
    });

    expect(retried.statusCode).toBe(201);
    expect(retried.json().issue.title).toBe('Fixed');
  });
});

describe('client-generated ids', () => {
  /** An offline client names the issue before the server has seen it. */
  test('the server honours a client-supplied issue id', async () => {
    const { owner, workspace, project } = await setup();
    const clientId = '99999999-8888-4777-8666-555555555555';

    const created = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { id: clientId, title: 'Named by client' },
      actor: owner,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().issue.id).toBe(clientId);

    // And it is addressable at that id immediately.
    const fetched = await request(`/workspaces/${workspace.id}/issues/${clientId}`, {
      actor: owner,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().issue.title).toBe('Named by client');
  });

  test('a malformed client id is rejected rather than ignored', async () => {
    const { owner, workspace, project } = await setup();

    const response = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { id: 'not-a-uuid', title: 'Nope' },
      actor: owner,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_failed');
  });
});

describe('backwards compatibility', () => {
  test('requests without a key behave exactly as before', async () => {
    const { owner, workspace, project } = await setup();
    const url = `/workspaces/${workspace.id}/projects/${project.id}/issues`;

    const first = await request(url, { method: 'POST', payload: { title: 'A' }, actor: owner });
    const second = await request(url, { method: 'POST', payload: { title: 'A' }, actor: owner });

    // Same payload, no key: two genuinely distinct issues.
    expect(first.json().issue.id).not.toBe(second.json().issue.id);
    expect((await request(url, { actor: owner })).json().issues).toHaveLength(2);
  });
});
