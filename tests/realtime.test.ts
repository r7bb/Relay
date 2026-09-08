import { createGateway } from '@relay/realtime/gateway';
import type { ServerMessage } from '@relay/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import {
  type Actor,
  TEST_URL,
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
 * Integration tests for the WebSocket gateway.
 *
 * These run a real gateway against a real Postgres and connect with a real
 * WebSocket client. The whole point of this layer is the interaction between
 * three processes -- API commits, Postgres notifies, gateway fans out -- and
 * none of that is exercised by unit-testing the pieces.
 */

let gateway: Awaited<ReturnType<typeof createGateway>>;
let listenClient: postgres.Sql;
let wsUrl: string;

beforeAll(async () => {
  const { db } = await getHarness();

  listenClient = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });

  // Port 0 lets the OS pick a free one, so the suite can't collide with a dev
  // gateway that happens to be running.
  gateway = await createGateway({ db, listenClient, port: 0, webOrigin: 'http://localhost:3000' });
  wsUrl = `ws://127.0.0.1:${gateway.port}/ws`;
});

beforeEach(resetDatabase);

afterAll(async () => {
  await gateway.close();
  await listenClient.end({ timeout: 5 });
  await closeHarness();
});

/** A connected client that records everything the gateway sends. */
class TestClient {
  readonly messages: ServerMessage[] = [];
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      this.messages.push(JSON.parse(String(event.data)) as ServerMessage);
    });
  }

  static async connect(actor: Actor): Promise<TestClient> {
    const socket = new WebSocket(wsUrl, { headers: { cookie: actor.cookie } } as never);

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
        once: true,
      });
    });

    return new TestClient(socket);
  }

  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  /** Wait for a message matching `predicate`, or throw on timeout. */
  async waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    timeoutMs = 5000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await Bun.sleep(25);
    }

    throw new Error(
      `Timed out. Received: ${JSON.stringify(this.messages.map((m) => m.type))}`,
    );
  }

  async subscribe(workspaceId: string) {
    this.send({ type: 'subscribe', workspaceId });
    return this.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ready' }> => m.type === 'ready',
    );
  }

  close() {
    this.socket.close();
  }
}

const isEvent = (type: string) => (m: ServerMessage): m is Extract<ServerMessage, { type: 'event' }> =>
  m.type === 'event' && m.event.type === type;

const isError = (m: ServerMessage): m is Extract<ServerMessage, { type: 'error' }> =>
  m.type === 'error';

const isPresence = (m: ServerMessage): m is Extract<ServerMessage, { type: 'presence' }> =>
  m.type === 'presence';

describe('connection', () => {
  test('rejects a socket with no session cookie', async () => {
    const socket = new WebSocket(wsUrl);

    const failed = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(false), { once: true });
      socket.addEventListener('error', () => resolve(true), { once: true });
      socket.addEventListener('close', () => resolve(true), { once: true });
    });

    expect(failed).toBe(true);
  });

  test('accepts a socket with a valid session', async () => {
    const actor = await createActor('Ada');
    const client = await TestClient.connect(actor);
    const workspace = await createWorkspace(actor);

    const ready = await client.subscribe(workspace.id);

    expect(ready.userId).toBe(actor.id);
    expect(ready.workspaceId).toBe(workspace.id);
    client.close();
  });

  /**
   * The socket carries the same cookie as the REST API, so it needs the same
   * tenant check. Authentication alone would let any account watch any
   * workspace's traffic.
   */
  test('refuses to subscribe to a workspace you are not a member of', async () => {
    const owner = await createActor('Owner');
    const stranger = await createActor('Stranger');
    const workspace = await createWorkspace(owner);

    const client = await TestClient.connect(stranger);
    client.send({ type: 'subscribe', workspaceId: workspace.id });

    const error = await client.waitFor(isError);
    expect(error.message).toContain('Not a member');

    client.close();
  });
});

describe('event fan-out', () => {
  test('an issue created over REST reaches a subscribed socket', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    const client = await TestClient.connect(owner);
    await client.subscribe(workspace.id);

    const created = await request(
      `/workspaces/${workspace.id}/projects/${project.id}/issues`,
      { method: 'POST', payload: { title: 'Realtime please' }, actor: owner },
    );
    expect(created.statusCode).toBe(201);

    const message = await client.waitFor(isEvent('issue.created'));
    expect(message.event).toMatchObject({
      type: 'issue.created',
      workspaceId: workspace.id,
      projectId: project.id,
      actorId: owner.id,
    });

    client.close();
  });

  test('a second member watching the same workspace also receives it', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const watcher = await TestClient.connect(member);
    await watcher.subscribe(workspace.id);

    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Seen by both' },
      actor: owner,
    });

    const message = await watcher.waitFor(isEvent('issue.created'));
    expect(message.event.workspaceId).toBe(workspace.id);

    watcher.close();
  });

  /**
   * The isolation property that matters: a socket subscribed to workspace A
   * must never see traffic from workspace B, even though both flow through the
   * same Postgres channel and the same gateway process.
   */
  test('events do not leak across workspaces', async () => {
    const alice = await createActor('Alice');
    const bob = await createActor('Bob');
    const alpha = await createWorkspace(alice, 'Alpha');
    const beta = await createWorkspace(bob, 'Beta');
    const betaProject = await createProject(bob, beta.id);

    const aliceClient = await TestClient.connect(alice);
    await aliceClient.subscribe(alpha.id);

    const bobClient = await TestClient.connect(bob);
    await bobClient.subscribe(beta.id);

    await request(`/workspaces/${beta.id}/projects/${betaProject.id}/issues`, {
      method: 'POST',
      payload: { title: 'Beta only' },
      actor: bob,
    });

    // Bob must see it...
    await bobClient.waitFor(isEvent('issue.created'));

    // ...and Alice must not. Bob's arrival proves the round trip completed, so
    // an empty inbox here is a real absence rather than a race.
    expect(aliceClient.messages.filter((m) => m.type === 'event')).toHaveLength(0);

    aliceClient.close();
    bobClient.close();
  });

  test('a status change publishes issue.updated', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);

    const issue = (
      await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
        method: 'POST',
        payload: { title: 'Move me' },
        actor: owner,
      })
    ).json().issue;

    const client = await TestClient.connect(owner);
    await client.subscribe(workspace.id);

    await request(`/workspaces/${workspace.id}/issues/${issue.id}`, {
      method: 'PATCH',
      payload: { status: 'IN_PROGRESS' },
      actor: owner,
    });

    const message = await client.waitFor(isEvent('issue.updated'));
    expect(message.event).toMatchObject({ issueId: issue.id, workspaceId: workspace.id });

    client.close();
  });

  /**
   * NOTIFY is transactional: a notification emitted inside a transaction is
   * delivered only if that transaction commits. A rejected write must therefore
   * produce no event at all.
   */
  test('a rejected write produces no event', async () => {
    const owner = await createActor('Owner');
    const guest = await createActor('Guest');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, guest, 'GUEST');

    const client = await TestClient.connect(owner);
    await client.subscribe(workspace.id);

    const refused = await request(
      `/workspaces/${workspace.id}/projects/${project.id}/issues`,
      { method: 'POST', payload: { title: 'Not allowed' }, actor: guest },
    );
    expect(refused.statusCode).toBe(403);

    // Follow with a write that *is* allowed; when its event arrives we know the
    // pipeline has drained past the rejected one.
    await request(`/workspaces/${workspace.id}/projects/${project.id}/issues`, {
      method: 'POST',
      payload: { title: 'Allowed' },
      actor: owner,
    });
    await client.waitFor(isEvent('issue.created'));

    const createdEvents = client.messages.filter(
      (m) => m.type === 'event' && m.event.type === 'issue.created',
    );
    expect(createdEvents).toHaveLength(1);

    client.close();
  });
});

describe('presence', () => {
  test('subscribing announces you to the workspace', async () => {
    const actor = await createActor('Ada Lovelace');
    const workspace = await createWorkspace(actor);

    const client = await TestClient.connect(actor);
    await client.subscribe(workspace.id);

    const presence = await client.waitFor(isPresence);
    expect(presence.users.map((u) => u.name)).toContain('Ada Lovelace');

    client.close();
  });

  test('two members see each other', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const first = await TestClient.connect(owner);
    await first.subscribe(workspace.id);

    const second = await TestClient.connect(member);
    await second.subscribe(workspace.id);

    // The roster is rebroadcast on every join, so wait for the one with both.
    const roster = await first.waitFor(
      (m): m is Extract<ServerMessage, { type: 'presence' }> =>
        m.type === 'presence' && m.users.length === 2,
    );

    expect(roster.users.map((u) => u.name).sort()).toEqual(['Member', 'Owner']);

    first.close();
    second.close();
  });

  test('reporting a location shows what someone is looking at', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    const project = await createProject(owner, workspace.id);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const watcher = await TestClient.connect(owner);
    await watcher.subscribe(workspace.id);

    const mover = await TestClient.connect(member);
    await mover.subscribe(workspace.id);
    mover.send({ type: 'location', location: project.id });

    const roster = await watcher.waitFor(
      (m): m is Extract<ServerMessage, { type: 'presence' }> =>
        m.type === 'presence' && m.users.some((u) => u.location === project.id),
    );

    expect(roster.users.find((u) => u.name === 'Member')?.location).toBe(project.id);

    watcher.close();
    mover.close();
  });

  test('disconnecting removes you from the roster', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const stayer = await TestClient.connect(owner);
    await stayer.subscribe(workspace.id);

    const leaver = await TestClient.connect(member);
    await leaver.subscribe(workspace.id);
    await stayer.waitFor(
      (m): m is Extract<ServerMessage, { type: 'presence' }> =>
        m.type === 'presence' && m.users.length === 2,
    );

    leaver.close();

    const roster = await stayer.waitFor(
      (m): m is Extract<ServerMessage, { type: 'presence' }> =>
        m.type === 'presence' && m.users.length === 1,
    );

    expect(roster.users.map((u) => u.name)).toEqual(['Owner']);

    stayer.close();
  });

  /** Three tabs is one person, not three. */
  test('multiple connections from one user collapse to a single entry', async () => {
    const actor = await createActor('Ada');
    const workspace = await createWorkspace(actor);

    const tabs = await Promise.all([
      TestClient.connect(actor),
      TestClient.connect(actor),
      TestClient.connect(actor),
    ]);
    for (const tab of tabs) await tab.subscribe(workspace.id);

    // Give the last join's broadcast time to land before reading the roster.
    await Bun.sleep(250);

    const latest = [...tabs[0]!.messages].reverse().find(isPresence)!;
    expect(latest.users).toHaveLength(1);
    expect(latest.users[0]!.name).toBe('Ada');

    for (const tab of tabs) tab.close();
  });
});
