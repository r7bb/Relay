import { type Database, documents, loadDocument, recordUpdate } from '@relay/database';
import type { DocumentAwareness } from '@relay/shared';
import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';

/**
 * Document rooms.
 *
 * A room holds one authoritative `Y.Doc` in memory, shared by everyone editing
 * it. Updates are broadcast to the other participants immediately and persisted
 * asynchronously, because a keystroke should not wait on a database write.
 *
 * Keeping a server-side replica -- rather than treating the gateway as a dumb
 * relay -- is what lets a client that joins late receive one catch-up message
 * instead of replaying the whole update log.
 */

export type Participant = {
  connectionId: string;
  userId: string;
  name: string;
  awareness: DocumentAwareness;
};

/** Debounce window for persistence. Batches a burst of typing into one write. */
const PERSIST_DEBOUNCE_MS = 500;

/** Postgres `foreign_key_violation` -- here, the document row is gone. */
const FOREIGN_KEY_VIOLATION = '23503';

function isMissingDocument(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === FOREIGN_KEY_VIOLATION
  );
}

export class DocumentRoom {
  readonly doc: Y.Doc;
  readonly participants = new Map<string, Participant>();

  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly documentId: string,
    doc: Y.Doc,
    private readonly db: Database,
  ) {
    this.doc = doc;
  }

  static async open(db: Database, documentId: string): Promise<DocumentRoom> {
    return new DocumentRoom(documentId, await loadDocument(db, documentId), db);
  }

  /** Everything a joining client needs to catch up, in one message. */
  fullState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * Apply a client's update to the shared replica and queue it for persistence.
   *
   * Returns false when the update was already known, so the caller can skip a
   * pointless broadcast. Yjs is idempotent, so re-applying is harmless -- but
   * echoing it to every other participant is not free.
   */
  applyUpdate(update: Uint8Array): boolean {
    // Yjs fires `update` only when the document actually moved, which is a
    // more reliable signal than diffing state vectors by hand.
    let changed = false;
    const observe = () => {
      changed = true;
    };

    this.doc.on('update', observe);
    try {
      Y.applyUpdate(this.doc, update);
    } finally {
      this.doc.off('update', observe);
    }

    if (changed) this.queuePersist(update);
    return changed;
  }

  private queuePersist(update: Uint8Array) {
    this.pending.push(update);
    if (this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      // A timer callback has no caller to reject to, so a failure here would
      // surface as an unhandled rejection and take the process down under
      // Bun's default. `flush` already decides what is retryable.
      void this.flush().catch((error) => {
        console.error(`document ${this.documentId}: persist failed`, error);
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Write pending updates as a single merged update.
   *
   * Merging first means a burst of typing costs one row rather than one per
   * keystroke, which keeps the compaction threshold meaningful.
   */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;

    const batch = this.pending;
    this.pending = [];

    try {
      // The room already holds the rendered text; passing it keeps the
      // search index current without rebuilding the document.
      await recordUpdate(
        this.db,
        this.documentId,
        Y.mergeUpdates(batch),
        this.doc.getText('content').toString(),
      );
    } catch (error) {
      // The document was deleted while these edits were still in the debounce
      // window. There is nothing to write them to, and requeueing would retry
      // forever, so drop them.
      if (isMissingDocument(error)) return;

      // Anything else is potentially transient: put them back so the next
      // flush retries rather than silently losing edits.
      this.pending.unshift(...batch);
      throw error;
    }
  }

  awarenessList() {
    return [...this.participants.values()].map((participant) => ({
      userId: participant.userId,
      name: participant.name,
      ...participant.awareness,
    }));
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/**
 * Rooms currently open on this gateway instance, keyed by document id.
 *
 * A room is opened on first join and closed when the last participant leaves,
 * so memory tracks concurrent editors rather than total documents.
 */
export class DocumentRooms {
  private readonly rooms = new Map<string, DocumentRoom>();
  /** In-flight opens, so two simultaneous joins share one load. */
  private readonly opening = new Map<string, Promise<DocumentRoom>>();

  constructor(private readonly db: Database) {}

  async join(documentId: string, participant: Participant): Promise<DocumentRoom> {
    const room = await this.acquire(documentId);
    room.participants.set(participant.connectionId, participant);
    return room;
  }

  private async acquire(documentId: string): Promise<DocumentRoom> {
    const existing = this.rooms.get(documentId);
    if (existing) return existing;

    const inFlight = this.opening.get(documentId);
    if (inFlight) return inFlight;

    const promise = DocumentRoom.open(this.db, documentId)
      .then((room) => {
        this.rooms.set(documentId, room);
        return room;
      })
      .finally(() => this.opening.delete(documentId));

    this.opening.set(documentId, promise);
    return promise;
  }

  get(documentId: string): DocumentRoom | undefined {
    return this.rooms.get(documentId);
  }

  /** Remove a participant, closing the room once it is empty. */
  async leave(documentId: string, connectionId: string): Promise<DocumentRoom | undefined> {
    const room = this.rooms.get(documentId);
    if (!room) return undefined;

    room.participants.delete(connectionId);

    if (room.participants.size === 0) {
      this.rooms.delete(documentId);
      await room.close();
      return undefined;
    }

    return room;
  }

  /** Drop a connection from every room it was in. */
  async leaveAll(connectionId: string): Promise<void> {
    for (const documentId of [...this.rooms.keys()]) {
      await this.leave(documentId, connectionId);
    }
  }

  async closeAll(): Promise<void> {
    for (const room of this.rooms.values()) await room.close();
    this.rooms.clear();
  }

  get size(): number {
    return this.rooms.size;
  }
}

/** Confirm a document exists in a workspace the caller belongs to. */
export async function documentInWorkspace(
  db: Database,
  documentId: string,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)))
    .limit(1);

  return Boolean(row);
}
