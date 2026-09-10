import type { IssuePriority, IssueStatus } from '@relay/shared';
import { STORE_QUEUE, type StorageAdapter } from './storage.ts';

/**
 * The offline write-ahead log.
 *
 * Every mutation is recorded here *before* it is attempted, and removed only
 * once the server has acknowledged it. A tab closed mid-flush, a dead battery,
 * or a five-hour flight all leave the queue intact on disk.
 */

export type QueuedMutation =
  | {
      kind: 'issue.create';
      /** Doubles as the Idempotency-Key and as the new issue's uuid. */
      id: string;
      workspaceId: string;
      projectId: string;
      input: { title: string; status?: IssueStatus; priority?: IssuePriority };
      queuedAt: number;
      attempts: number;
      lastError?: string;
    }
  | {
      kind: 'issue.update';
      id: string;
      workspaceId: string;
      issueId: string;
      input: Partial<{ title: string; status: IssueStatus; priority: IssuePriority }>;
      /** `updatedAt` of the row this edit was based on, for conflict detection. */
      baseUpdatedAt: string | null;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    }
  | {
      kind: 'issue.delete';
      id: string;
      workspaceId: string;
      issueId: string;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    };

export type MutationKind = QueuedMutation['kind'];

export class MutationQueue {
  constructor(private readonly storage: StorageAdapter) {}

  /**
   * Queue order is `queuedAt`, so a create is always flushed before the edits
   * that were made against it. Sorting on read rather than relying on insertion
   * order keeps this true across a reload, where IndexedDB gives no ordering
   * guarantee beyond the key.
   */
  async all(): Promise<QueuedMutation[]> {
    const items = await this.storage.getAll<QueuedMutation>(STORE_QUEUE);
    return items.sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  }

  async enqueue(mutation: QueuedMutation): Promise<void> {
    await this.storage.put(STORE_QUEUE, mutation.id, mutation);
  }

  async remove(id: string): Promise<void> {
    await this.storage.delete(STORE_QUEUE, id);
  }

  async recordFailure(id: string, error: string): Promise<void> {
    const existing = await this.storage.get<QueuedMutation>(STORE_QUEUE, id);
    if (!existing) return;

    await this.storage.put(STORE_QUEUE, id, {
      ...existing,
      attempts: existing.attempts + 1,
      lastError: error,
    });
  }

  async size(): Promise<number> {
    return (await this.storage.getAll(STORE_QUEUE)).length;
  }

  async clear(): Promise<void> {
    await this.storage.clear(STORE_QUEUE);
  }
}
