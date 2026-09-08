import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type LocalIssue,
  MemoryAdapter,
  STORE_ISSUES,
  SyncEngine,
  SyncError,
  type SyncTransport,
} from '@relay/sync';

/**
 * Unit tests for the offline engine.
 *
 * No database and no browser: the transport and the storage are both injected,
 * which is the point of those interfaces. Failure modes that are painful to
 * stage against a real server -- a lost response, a permanent refusal, a
 * five-hour offline stretch -- are one line here.
 */

let clock = 1_000;
const tick = () => (clock += 10);

let idCounter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

/** Records calls and can be told to fail. */
class FakeTransport implements SyncTransport {
  calls: { method: string; key: string }[] = [];
  serverIssues = new Map<string, LocalIssue>();
  /** Idempotency ledger, mirroring what the API does. */
  private ledger = new Map<string, { issue: LocalIssue }>();
  failWith: SyncError | null = null;
  /** Simulates a response lost in transit: the server applied it, client didn't hear. */
  dropNextResponse = false;
  private nextNumber = 1;

  async createIssue(
    _workspaceId: string,
    projectId: string,
    body: { id: string; title: string; status?: LocalIssue['status'] },
    idempotencyKey: string,
  ) {
    this.calls.push({ method: 'create', key: idempotencyKey });
    if (this.failWith) throw this.failWith;

    const replayed = this.ledger.get(idempotencyKey);
    if (replayed) return replayed;

    const number = this.nextNumber++;
    const issue: LocalIssue = {
      id: body.id,
      key: `REL-${number}`,
      number,
      title: body.title,
      status: body.status ?? 'TODO',
      priority: 'NONE',
      assigneeId: null,
      assigneeName: null,
      projectId,
      updatedAt: new Date(clock).toISOString(),
      pending: false,
    };

    this.serverIssues.set(issue.id, issue);
    this.ledger.set(idempotencyKey, { issue });

    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new SyncError('network dropped after the server applied it');
    }

    return { issue };
  }

  async updateIssue(
    _workspaceId: string,
    issueId: string,
    body: Partial<LocalIssue>,
    idempotencyKey: string,
  ) {
    this.calls.push({ method: 'update', key: idempotencyKey });
    if (this.failWith) throw this.failWith;

    const current = this.serverIssues.get(issueId);
    if (!current) throw new SyncError('Issue not found', 404);

    const issue = { ...current, ...body, updatedAt: new Date(tick()).toISOString() };
    this.serverIssues.set(issueId, issue);
    return { issue };
  }

  async listIssues(_workspaceId: string, projectId: string) {
    return {
      issues: [...this.serverIssues.values()].filter((i) => i.projectId === projectId),
    };
  }
}

const WORKSPACE = 'ws-1';
const PROJECT = 'proj-1';

let storage: MemoryAdapter;
let transport: FakeTransport;
let engine: SyncEngine;

beforeEach(() => {
  clock = 1_000;
  idCounter = 0;
  storage = new MemoryAdapter();
  transport = new FakeTransport();
  engine = new SyncEngine(storage, transport, tick, nextId);
});

describe('writing while offline', () => {
  test('a create is visible locally before it reaches the server', async () => {
    const issue = await engine.createIssue(WORKSPACE, PROJECT, { title: 'Offline issue' });

    expect(issue.pending).toBe(true);
    expect(await engine.localIssues(PROJECT)).toHaveLength(1);
    // Nothing was sent.
    expect(transport.calls).toHaveLength(0);
    expect(await engine.queue.size()).toBe(1);
  });

  test('an offline issue can be edited before it has ever synced', async () => {
    const created = await engine.createIssue(WORKSPACE, PROJECT, { title: 'Draft' });
    await engine.updateIssue(WORKSPACE, created.id, { status: 'IN_PROGRESS' });

    const [local] = await engine.localIssues(PROJECT);
    expect(local!.status).toBe('IN_PROGRESS');
    expect(local!.pending).toBe(true);
  });

  test('many offline mutations all survive in the queue', async () => {
    for (let i = 0; i < 20; i++) {
      await engine.createIssue(WORKSPACE, PROJECT, { title: `Offline ${i}` });
    }

    expect(await engine.queue.size()).toBe(20);
    expect(await engine.localIssues(PROJECT)).toHaveLength(20);
  });
});

describe('flushing', () => {
  test('reconnecting drains the queue and clears pending flags', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'One' });
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Two' });

    const result = await engine.flush();

    expect(result).toEqual({ flushed: 2, failed: 0, discarded: 0 });
    expect(await engine.queue.size()).toBe(0);
    expect((await engine.localIssues(PROJECT)).every((i) => !i.pending)).toBe(true);
  });

  test('the server assigns real issue keys on sync', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Needs a number' });
    expect((await engine.localIssues(PROJECT))[0]!.key).toBe('…');

    await engine.flush();

    expect((await engine.localIssues(PROJECT))[0]!.key).toBe('REL-1');
  });

  test('creates flush before the edits made against them', async () => {
    const created = await engine.createIssue(WORKSPACE, PROJECT, { title: 'First' });
    await engine.updateIssue(WORKSPACE, created.id, { status: 'DONE' });

    await engine.flush();

    expect(transport.calls.map((c) => c.method)).toEqual(['create', 'update']);
    expect(transport.serverIssues.get(created.id)?.status).toBe('DONE');
  });

  /**
   * The reason each mutation carries a stable key. Without it, a retry after a
   * lost response creates a second issue.
   */
  test('a response lost in transit does not duplicate the issue on retry', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Exactly once' });

    transport.dropNextResponse = true;
    const first = await engine.flush();
    expect(first.failed).toBe(1);
    // Still queued, because as far as the client knows it never landed.
    expect(await engine.queue.size()).toBe(1);

    const second = await engine.flush();
    expect(second.flushed).toBe(1);

    // Two attempts, one issue.
    expect(transport.calls.filter((c) => c.method === 'create')).toHaveLength(2);
    expect(transport.serverIssues.size).toBe(1);
  });

  test('the same idempotency key is reused across retries', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Stable key' });

    transport.dropNextResponse = true;
    await engine.flush();
    await engine.flush();

    const keys = transport.calls.filter((c) => c.method === 'create').map((c) => c.key);
    expect(new Set(keys).size).toBe(1);
  });

  test('a transient failure stops the flush and keeps everything queued', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'One' });
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Two' });

    transport.failWith = new SyncError('offline');
    const result = await engine.flush();

    expect(result.flushed).toBe(0);
    expect(result.failed).toBe(1);
    // Halted at the first failure rather than trying the rest out of order.
    expect(await engine.queue.size()).toBe(2);
  });

  /** A mutation the server will never accept must not wedge the queue. */
  test('a permanently refused mutation is dropped, not retried forever', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Refused' });

    transport.failWith = new SyncError('Forbidden', 403);
    const result = await engine.flush();

    expect(result.discarded).toBe(1);
    expect(await engine.queue.size()).toBe(0);
    // The local row is rolled back, so the UI stops showing work that will
    // never exist.
    expect(await engine.localIssues(PROJECT)).toHaveLength(0);
  });

  test('rate limiting is treated as transient, not permanent', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Slow down' });

    transport.failWith = new SyncError('Too many requests', 429);
    const result = await engine.flush();

    expect(result.discarded).toBe(0);
    expect(await engine.queue.size()).toBe(1);
  });

  test('repeated edits to one issue collapse into a single request', async () => {
    const created = await engine.createIssue(WORKSPACE, PROJECT, { title: 'Dragged' });
    await engine.flush();
    transport.calls = [];

    await engine.updateIssue(WORKSPACE, created.id, { status: 'IN_PROGRESS' });
    await engine.updateIssue(WORKSPACE, created.id, { status: 'IN_REVIEW' });
    await engine.updateIssue(WORKSPACE, created.id, { status: 'DONE' });

    expect(await engine.queue.size()).toBe(1);
    await engine.flush();

    expect(transport.calls).toHaveLength(1);
    expect(transport.serverIssues.get(created.id)?.status).toBe('DONE');
  });
});

describe('reconciling', () => {
  test('server state replaces local state for synced rows', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Mine' });
    await engine.flush();

    // Someone else renames it.
    const [id] = [...transport.serverIssues.keys()];
    const server = transport.serverIssues.get(id!)!;
    transport.serverIssues.set(id!, { ...server, title: 'Renamed by someone else' });

    await engine.reconcile(WORKSPACE, PROJECT);

    expect((await engine.localIssues(PROJECT))[0]!.title).toBe('Renamed by someone else');
  });

  /**
   * The property that makes offline work safe: reconciling must never silently
   * discard something the user can still see as unsaved.
   */
  test('unflushed local work survives a reconcile', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Synced' });
    await engine.flush();

    const offline = await engine.createIssue(WORKSPACE, PROJECT, { title: 'Still offline' });

    await engine.reconcile(WORKSPACE, PROJECT);

    const titles = (await engine.localIssues(PROJECT)).map((i) => i.title);
    expect(titles).toContain('Still offline');
    expect(await engine.queue.size()).toBe(1);

    // And it still flushes correctly afterwards.
    await engine.flush();
    expect(transport.serverIssues.get(offline.id)?.title).toBe('Still offline');
  });

  test('an issue deleted elsewhere disappears locally', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Doomed' });
    await engine.flush();

    transport.serverIssues.clear();
    await engine.reconcile(WORKSPACE, PROJECT);

    expect(await engine.localIssues(PROJECT)).toHaveLength(0);
  });
});

/**
 * The scenario from the project brief: two people edit the same workspace while
 * one of them is offline, then everything reconnects and must agree.
 */
describe('convergence', () => {
  test('two clients converge after one works offline', async () => {
    const alice = engine;
    const bobStorage = new MemoryAdapter();
    const bob = new SyncEngine(
      bobStorage,
      transport,
      tick,
      () => `11111111-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
    );

    // Both online, Alice creates something.
    const shared = await alice.createIssue(WORKSPACE, PROJECT, { title: 'Shared work' });
    await alice.flush();
    await bob.reconcile(WORKSPACE, PROJECT);

    expect(await bob.localIssues(PROJECT)).toHaveLength(1);

    // Alice goes offline and keeps working.
    await alice.createIssue(WORKSPACE, PROJECT, { title: 'Alice offline A' });
    await alice.createIssue(WORKSPACE, PROJECT, { title: 'Alice offline B' });
    await alice.updateIssue(WORKSPACE, shared.id, { priority: 'URGENT' });

    // Meanwhile Bob, still online, moves the shared issue.
    await bob.updateIssue(WORKSPACE, shared.id, { status: 'IN_PROGRESS' });
    await bob.flush();

    // Alice reconnects.
    await alice.flush();
    await alice.reconcile(WORKSPACE, PROJECT);
    await bob.reconcile(WORKSPACE, PROJECT);

    const aliceState = await alice.localIssues(PROJECT);
    const bobState = await bob.localIssues(PROJECT);

    // Both see the same set of issues...
    expect(aliceState.map((i) => i.id).sort()).toEqual(bobState.map((i) => i.id).sort());
    expect(aliceState).toHaveLength(3);

    // ...and neither has anything left to send.
    expect(await alice.queue.size()).toBe(0);
    expect(await bob.queue.size()).toBe(0);

    // Both of Alice's offline creates survived.
    const titles = aliceState.map((i) => i.title).sort();
    expect(titles).toEqual(['Alice offline A', 'Alice offline B', 'Shared work']);

    // The concurrent edits to the shared issue merged per-field: Bob's status
    // and Alice's priority both survived, because they touched different
    // fields. This is last-write-wins per field, not per row.
    const sharedFinal = aliceState.find((i) => i.id === shared.id)!;
    expect(sharedFinal.priority).toBe('URGENT');
    expect(sharedFinal.status).toBe('IN_PROGRESS');
  });

  test('local state is byte-identical across clients after convergence', async () => {
    const alice = engine;
    const bob = new SyncEngine(
      new MemoryAdapter(),
      transport,
      tick,
      () => `22222222-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
    );

    await alice.createIssue(WORKSPACE, PROJECT, { title: 'A' });
    await bob.createIssue(WORKSPACE, PROJECT, { title: 'B' });

    await alice.flush();
    await bob.flush();
    await alice.reconcile(WORKSPACE, PROJECT);
    await bob.reconcile(WORKSPACE, PROJECT);

    expect(await alice.localIssues(PROJECT)).toEqual(await bob.localIssues(PROJECT));
  });
});

describe('durability', () => {
  /** The queue lives on disk, so a reload mid-flight loses nothing. */
  test('a new engine over the same storage picks up the pending queue', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Survives reload' });

    const reloaded = new SyncEngine(storage, transport, tick, nextId);

    expect(await reloaded.queue.size()).toBe(1);
    expect(await reloaded.localIssues(PROJECT)).toHaveLength(1);

    await reloaded.flush();
    expect(transport.serverIssues.size).toBe(1);
  });

  test('failed attempts are counted for backoff and diagnostics', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Flaky' });

    transport.failWith = new SyncError('offline');
    await engine.flush();
    await engine.flush();

    const [queued] = await engine.queue.all();
    expect(queued!.attempts).toBe(2);
    expect(queued!.lastError).toContain('offline');
  });

  test('storage is not corrupted by an interleaved read during flush', async () => {
    await engine.createIssue(WORKSPACE, PROJECT, { title: 'Concurrent' });

    const [flushResult, issues] = await Promise.all([engine.flush(), engine.localIssues(PROJECT)]);

    expect(flushResult.flushed).toBe(1);
    expect(issues).toHaveLength(1);
    expect(await storage.getAll(STORE_ISSUES)).toHaveLength(1);
  });
});
