import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { documents, searchWorkspace } from '@relay/database';
import {
  type Actor,
  closeHarness,
  createActor,
  createProject,
  createWorkspace,
  getHarness,
  request,
  resetDatabase,
} from './harness.ts';

/**
 * Full-text search.
 *
 * The index is a stored generated column, so most of what is worth asserting
 * is that it stays in step with writes without anything having to remember to
 * update it -- and that a search cannot reach across a tenant boundary.
 */

beforeEach(resetDatabase);
afterAll(closeHarness);

async function workspaceWithIssues(titles: string[], descriptions: string[] = []) {
  const owner = await createActor('Owner');
  const workspace = await createWorkspace(owner);
  const project = await createProject(owner, workspace.id);

  for (const [index, title] of titles.entries()) {
    const description = descriptions[index];

    const response = await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      // Omit rather than send undefined/null: the schema accepts an absent
      // description, not a null one.
      payload: description ? { title, description } : { title },
      actor: owner,
    });

    // Failing loudly here matters: a silently rejected create makes a later
    // assertion fail for a reason that has nothing to do with search.
    if (response.statusCode !== 201) {
      throw new Error(`Seeding issue failed: ${response.statusCode} ${response.body}`);
    }
  }

  return { owner, workspace, project };
}

const search = async (actor: Actor, workspaceId: string, q: string) =>
  (await request(`/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`, { actor })).json();

describe('finding things', () => {
  test('matches an issue title', async () => {
    const { owner, workspace } = await workspaceWithIssues([
      'Fix OAuth refresh token',
      'Update the changelog',
    ]);

    const { results } = await search(owner, workspace.id, 'oauth');

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('issue');
    expect(results[0].title).toBe('Fix OAuth refresh token');
  });

  test('matches an issue description', async () => {
    const { owner, workspace } = await workspaceWithIssues(
      ['Something vague'],
      ['The Safari cookie jar drops the session'],
    );

    const { results } = await search(owner, workspace.id, 'safari');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Something vague');
  });

  /** English stemming is the reason to use a tsvector rather than LIKE. */
  test('stems, so a search finds other forms of the word', async () => {
    const { owner, workspace } = await workspaceWithIssues(['Running the migrations']);

    expect((await search(owner, workspace.id, 'run')).results).toHaveLength(1);
    expect((await search(owner, workspace.id, 'migrate')).results).toHaveLength(1);
  });

  test('is case-insensitive', async () => {
    const { owner, workspace } = await workspaceWithIssues(['Billing Settings Page']);

    expect((await search(owner, workspace.id, 'BILLING')).results).toHaveLength(1);
  });

  test('a title match outranks the same word in a description', async () => {
    const { owner, workspace } = await workspaceWithIssues(
      ['Buried mention', 'Deployment checklist'],
      ['We should think about deployment eventually'],
    );

    const { results } = await search(owner, workspace.id, 'deployment');

    expect(results).toHaveLength(2);
    // Weight A on the title is what produces this ordering.
    expect(results[0].title).toBe('Deployment checklist');
  });

  test('finds comments, and points at the issue holding them', async () => {
    const { owner, workspace, project } = await workspaceWithIssues(['Some issue']);

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Another issue' },
        actor: owner,
      })
    ).json().issue;

    await request(`/workspaces/${workspace.id}/issues/${issue.id}/comments`, {
      method: 'POST',
      payload: { body: 'This is blocked on the certificate rotation' },
      actor: owner,
    });

    const { results } = await search(owner, workspace.id, 'certificate');

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('comment');
    expect(results[0].issueId).toBe(issue.id);
  });

  test('finds documents by title', async () => {
    const { db } = await getHarness();
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);

    await db.insert(documents).values({
      workspaceId: workspace.id,
      title: 'Authentication architecture',
      createdBy: owner.id,
    });

    const { results } = await search(owner, workspace.id, 'architecture');
    expect(results[0].kind).toBe('document');
  });

  test('finds documents by their rendered text', async () => {
    const { db } = await getHarness();
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);

    await db.insert(documents).values({
      workspaceId: workspace.id,
      title: 'Notes',
      searchText: 'We decided to use Postgres LISTEN NOTIFY for fan-out',
      createdBy: owner.id,
    });

    const { results } = await search(owner, workspace.id, 'fan-out');
    expect(results[0].title).toBe('Notes');
  });

  test('returns a highlighted snippet', async () => {
    const { owner, workspace } = await workspaceWithIssues(
      ['Investigate'],
      ['The refresh token expires far too early in production'],
    );

    const { results } = await search(owner, workspace.id, 'token');
    expect(results[0].snippet).toContain('<mark>');
  });

  test('an empty query returns nothing rather than everything', async () => {
    const { owner, workspace } = await workspaceWithIssues(['Anything']);

    expect((await search(owner, workspace.id, '')).results).toEqual([]);
    expect((await search(owner, workspace.id, '   ')).results).toEqual([]);
  });

  test('no matches is an empty list, not an error', async () => {
    const { owner, workspace } = await workspaceWithIssues(['Something']);

    const response = await request(`/workspaces/${workspace.id}/search?q=zzzznothing`, {
      actor: owner,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([]);
  });

  /**
   * `websearch_to_tsquery` is used precisely so a user typing punctuation gets
   * no results rather than a 500 from a syntax error.
   */
  test('punctuation and operators do not blow up the query', async () => {
    const { owner, workspace } = await workspaceWithIssues(['Ordinary issue']);

    for (const query of ['&& ||', '!!!', '(((', 'a & b | c', "'quoted", ':*']) {
      const response = await request(
        `/workspaces/${workspace.id}/search?q=${encodeURIComponent(query)}`,
        { actor: owner },
      );
      expect(response.statusCode, query).toBe(200);
    }
  });

  test('quoted phrases match as a phrase', async () => {
    const { owner, workspace } = await workspaceWithIssues([
      'refresh token rotation',
      'token refresh is unrelated here',
    ]);

    const { results } = await search(owner, workspace.id, '"refresh token"');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('refresh token rotation');
  });

  test('a leading minus excludes', async () => {
    const { owner, workspace } = await workspaceWithIssues(['deploy the api', 'deploy the worker']);

    const { results } = await search(owner, workspace.id, 'deploy -worker');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('deploy the api');
  });
});

describe('the index stays in step', () => {
  /** A generated column is the reason there is nothing to remember here. */
  test('a new issue is findable immediately', async () => {
    const { owner, workspace, project } = await workspaceWithIssues([]);

    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Brand new thing' },
      actor: owner,
    });

    expect((await search(owner, workspace.id, 'brand new')).results).toHaveLength(1);
  });

  test('editing an issue updates what it matches', async () => {
    const { owner, workspace, project } = await workspaceWithIssues([]);

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Original wording' },
        actor: owner,
      })
    ).json().issue;

    await request(`/workspaces/${workspace.id}/issues/${issue.id}`, {
      method: 'PATCH',
      payload: { title: 'Completely different subject' },
      actor: owner,
    });

    expect((await search(owner, workspace.id, 'original')).results).toEqual([]);
    expect((await search(owner, workspace.id, 'subject')).results).toHaveLength(1);
  });

  test('a deleted issue stops matching', async () => {
    const { owner, workspace, project } = await workspaceWithIssues([]);

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Temporary' },
        actor: owner,
      })
    ).json().issue;

    await request(`/workspaces/${workspace.id}/issues/${issue.id}`, {
      method: 'DELETE',
      actor: owner,
    });

    expect((await search(owner, workspace.id, 'temporary')).results).toEqual([]);
  });
});

describe('search respects the tenant boundary', () => {
  /** The index must not be a side door around authorization. */
  test('results never cross into another workspace', async () => {
    const { db } = await getHarness();
    const alice = await createActor('Alice');
    const bob = await createActor('Bob');

    const alpha = await createWorkspace(alice, 'Alpha');
    const beta = await createWorkspace(bob, 'Beta');
    const betaProject = await createProject(bob, beta.id);

    await request(`/workspaces/${beta.id}/projects/${betaProject.id}/issues`, {
      method: 'POST',
      payload: { title: 'Confidential merger plans' },
      actor: bob,
    });

    // Bob can find it...
    expect((await search(bob, beta.id, 'merger')).results).toHaveLength(1);

    // ...Alice cannot, searching her own workspace...
    expect((await search(alice, alpha.id, 'merger')).results).toEqual([]);

    // ...and cannot reach it by pointing at Bob's workspace either.
    const trespass = await request(`/workspaces/${beta.id}/search?q=merger`, { actor: alice });
    expect(trespass.statusCode).toBe(404);

    // The underlying query is scoped too, not just the route.
    expect(await searchWorkspace(db, alpha.id, 'merger')).toEqual([]);
  });

  test('searching requires a session', async () => {
    const { workspace } = await workspaceWithIssues(['Anything']);

    const response = await request(`/workspaces/${workspace.id}/search?q=anything`);
    expect(response.statusCode).toBe(401);
  });

  test('a guest can search, since they can read', async () => {
    const { owner, workspace } = await workspaceWithIssues(['Readable by all']);
    const guest = await createActor('Guest');

    await request(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      payload: { email: guest.email, role: 'GUEST' },
      actor: owner,
    });

    expect((await search(guest, workspace.id, 'readable')).results).toHaveLength(1);
  });
});
