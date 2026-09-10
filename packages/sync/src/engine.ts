import type { IssuePriority, IssueStatus } from '@relay/shared';
import { MutationQueue, type QueuedMutation } from './queue.ts';
import { STORE_ISSUES, type StorageAdapter } from './storage.ts';

/**
 * Offline-first sync engine.
 *
 * The rule the whole design follows: **the local store is the source of truth
 * for the UI, and the server is the source of truth for the world.** A write
 * lands locally and returns immediately; reconciling it with the server happens
 * afterwards, and may happen much later.
 */

export type LocalIssue = {
  id: string;
  key: string;
  number: number;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  assigneeName: string | null;
  projectId: string;
  updatedAt: string | null;
  /** True while the row exists only locally or has unflushed edits. */
  pending: boolean;
};

/** Transport, injected so the engine can be tested without a server. */
export interface SyncTransport {
  createIssue(
    workspaceId: string,
    projectId: string,
    body: { id: string; title: string; status?: IssueStatus; priority?: IssuePriority },
    idempotencyKey: string,
  ): Promise<{ issue: LocalIssue }>;

  updateIssue(
    workspaceId: string,
    issueId: string,
    body: Partial<{ title: string; status: IssueStatus; priority: IssuePriority }>,
    idempotencyKey: string,
  ): Promise<{ issue: LocalIssue }>;

  /** Naturally idempotent, so it takes no idempotency key. */
  deleteIssue(workspaceId: string, issueId: string): Promise<void>;

  listIssues(workspaceId: string, projectId: string): Promise<{ issues: LocalIssue[] }>;
}

export class SyncError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the failure came from the server rather than the network. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export type FlushResult = {
  flushed: number;
  failed: number;
  /** Mutations dropped because the server refused them permanently. */
  discarded: number;
};

/**
 * A 4xx other than 408/429 means the server understood and refused. Retrying
 * cannot help, and leaving it queued would block every mutation behind it
 * forever -- the classic poison-message stall.
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof SyncError) || error.status === undefined) return false;
  if (error.status === 408 || error.status === 429) return false;
  return error.status >= 400 && error.status < 500;
}

export class SyncEngine {
  readonly queue: MutationQueue;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly transport: SyncTransport,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    this.queue = new MutationQueue(storage);
  }

  // ----------------------------------------------------------------- reads

  async localIssues(projectId: string): Promise<LocalIssue[]> {
    const all = await this.storage.getAll<LocalIssue>(STORE_ISSUES);
    return all.filter((issue) => issue.projectId === projectId).sort((a, b) => b.number - a.number);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Create an issue locally and queue it. Returns immediately -- the caller does
   * not await the network.
   *
   * The issue gets its uuid here, on the client, so the UI can render and edit
   * it before the server has ever heard of it. Until it syncs it has no real
   * issue number, so it is shown with a placeholder key.
   */
  async createIssue(
    workspaceId: string,
    projectId: string,
    input: { title: string; status?: IssueStatus; priority?: IssuePriority },
  ): Promise<LocalIssue> {
    const id = this.newId();

    const issue: LocalIssue = {
      id,
      key: '…',
      // Sorts above everything real, so an offline create appears at the top
      // of the column where the user expects it.
      number: Number.MAX_SAFE_INTEGER,
      title: input.title,
      status: input.status ?? 'TODO',
      priority: input.priority ?? 'NONE',
      assigneeId: null,
      assigneeName: null,
      projectId,
      updatedAt: null,
      pending: true,
    };

    await this.storage.put(STORE_ISSUES, id, issue);
    await this.queue.enqueue({
      kind: 'issue.create',
      id,
      workspaceId,
      projectId,
      input,
      queuedAt: this.now(),
      attempts: 0,
    });

    return issue;
  }

  async updateIssue(
    workspaceId: string,
    issueId: string,
    input: Partial<{ title: string; status: IssueStatus; priority: IssuePriority }>,
  ): Promise<LocalIssue | undefined> {
    const existing = await this.storage.get<LocalIssue>(STORE_ISSUES, issueId);
    if (!existing) return undefined;

    const updated: LocalIssue = { ...existing, ...input, pending: true };
    await this.storage.put(STORE_ISSUES, issueId, updated);

    await this.queue.enqueue({
      kind: 'issue.update',
      // One queue entry per issue per field-set: re-editing an issue that is
      // still queued replaces the pending mutation rather than stacking a
      // second one, so dragging a card three times sends one final state.
      id: `update:${issueId}`,
      workspaceId,
      issueId,
      input: { ...(await this.pendingUpdateInput(issueId)), ...input },
      baseUpdatedAt: existing.updatedAt,
      queuedAt: this.now(),
      attempts: 0,
    });

    return updated;
  }

  /**
   * Delete an issue locally and queue the deletion.
   *
   * Two subtleties, both about an issue that was created offline and deleted
   * before it ever synced:
   *
   * A queued create for the same issue is removed -- but a delete is still
   * queued rather than treating the pair as a no-op. Cancelling both looks
   * tempting and is racy: the create may already be in flight, in which case
   * the row would land on the server with nothing left to remove it, and the
   * next reconcile would resurrect a row the user deleted. Queuing the delete
   * converges either way, at the cost of one request that may 404 -- and a
   * 404 on a delete means the desired state already holds.
   *
   * Queued edits for the row are dropped outright: they describe a row that
   * is going away, and flushing them first would be work the server undoes.
   */
  async deleteIssue(workspaceId: string, issueId: string): Promise<void> {
    const existing = await this.storage.get<LocalIssue>(STORE_ISSUES, issueId);
    if (!existing) return;

    await this.storage.delete(STORE_ISSUES, issueId);

    await this.queue.remove(`update:${issueId}`);
    await this.queue.remove(issueId);

    await this.queue.enqueue({
      kind: 'issue.delete',
      id: `delete:${issueId}`,
      workspaceId,
      issueId,
      queuedAt: this.now(),
      attempts: 0,
    });
  }

  /** Merge with any update already queued for this issue. */
  private async pendingUpdateInput(issueId: string) {
    const queued = await this.queue.all();
    const existing = queued.find((m) => m.kind === 'issue.update' && m.issueId === issueId);
    return existing?.kind === 'issue.update' ? existing.input : {};
  }

  // ----------------------------------------------------------------- flush

  /**
   * Drain the queue in order.
   *
   * Stops at the first transient failure: the queue is ordered, and a create
   * that has not landed must not be overtaken by an edit that references it.
   * Permanent refusals are dropped instead, so one bad mutation cannot wedge
   * the queue.
   */
  async flush(): Promise<FlushResult> {
    const result: FlushResult = { flushed: 0, failed: 0, discarded: 0 };

    for (const mutation of await this.queue.all()) {
      try {
        await this.apply(mutation);
        await this.queue.remove(mutation.id);
        result.flushed++;
      } catch (error) {
        if (isPermanent(error)) {
          await this.queue.remove(mutation.id);
          await this.revert(mutation);
          result.discarded++;
          continue;
        }

        await this.queue.recordFailure(mutation.id, String(error));
        result.failed++;
        break;
      }
    }

    return result;
  }

  private async apply(mutation: QueuedMutation): Promise<void> {
    if (mutation.kind === 'issue.create') {
      // The mutation id is both the issue's uuid and the idempotency key, so a
      // replay after a lost response returns the original result.
      const { issue } = await this.transport.createIssue(
        mutation.workspaceId,
        mutation.projectId,
        { id: mutation.id, ...mutation.input },
        mutation.id,
      );

      await this.storage.put(STORE_ISSUES, issue.id, { ...issue, pending: false });
      return;
    }

    if (mutation.kind === 'issue.delete') {
      try {
        await this.transport.deleteIssue(mutation.workspaceId, mutation.issueId);
      } catch (error) {
        // The row is already gone -- someone else deleted it, or our own
        // create never reached the server. Either way the intent is satisfied,
        // so this is success rather than a mutation to discard.
        if (error instanceof SyncError && error.status === 404) return;
        throw error;
      }
      return;
    }

    const { issue } = await this.transport.updateIssue(
      mutation.workspaceId,
      mutation.issueId,
      mutation.input,
      `${mutation.id}:${mutation.queuedAt}`,
    );

    await this.storage.put(STORE_ISSUES, issue.id, { ...issue, pending: false });
  }

  /** Undo a local change the server permanently refused. */
  private async revert(mutation: QueuedMutation): Promise<void> {
    if (mutation.kind === 'issue.create') {
      await this.storage.delete(STORE_ISSUES, mutation.id);
    }
    // A refused update is repaired by the next reconcile, which overwrites the
    // local row with the server's version. So is a refused delete -- the row
    // is still on the server, and reconcile puts it back on screen, which is
    // the honest outcome when the server says you may not remove it.
  }

  // ------------------------------------------------------------- reconcile

  /**
   * Replace the local view of a project with the server's, preserving anything
   * still queued.
   *
   * Server state wins for everything already acknowledged -- that is what makes
   * a missed realtime event self-healing. Rows with unflushed local edits keep
   * their local values, because discarding them would silently lose work the
   * user can see on screen.
   */
  async reconcile(workspaceId: string, projectId: string): Promise<void> {
    const { issues } = await this.transport.listIssues(workspaceId, projectId);

    const queued = await this.queue.all();
    const pendingIds = new Set(queued.map((m) => (m.kind === 'issue.create' ? m.id : m.issueId)));

    const serverIds = new Set(issues.map((i) => i.id));

    for (const issue of issues) {
      if (pendingIds.has(issue.id)) continue;
      await this.storage.put(STORE_ISSUES, issue.id, { ...issue, pending: false });
    }

    // Drop local rows the server no longer has -- deleted by someone else --
    // unless we are still holding an unflushed mutation for them.
    for (const local of await this.localIssues(projectId)) {
      if (!serverIds.has(local.id) && !pendingIds.has(local.id)) {
        await this.storage.delete(STORE_ISSUES, local.id);
      }
    }
  }
}
