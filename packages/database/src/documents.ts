import { and, asc, eq, lte } from 'drizzle-orm';
import * as Y from 'yjs';
import type { Executor } from './index.ts';
import { documents, documentUpdates } from './schema.ts';

/**
 * Persistence for Yjs documents.
 *
 * The storage shape is a compacted snapshot plus an append-only log of updates
 * recorded after it. Writing a full snapshot per keystroke would rewrite the
 * whole document for a one-character edit; appending keeps a write proportional
 * to the change. The log is folded back into the snapshot once it grows past
 * `COMPACT_THRESHOLD`.
 *
 * Nothing here interprets the bytes. Yjs owns the merge semantics, which is
 * what makes concurrent edits converge without the server choosing a winner.
 */

/** Fold the update log into the snapshot once it reaches this many rows. */
export const COMPACT_THRESHOLD = 100;

/** Rebuild a document's current state from its snapshot plus pending updates. */
export async function loadDocument(db: Executor, documentId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();

  const [row] = await db
    .select({ snapshot: documents.snapshot })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (row?.snapshot) Y.applyUpdate(doc, row.snapshot);

  const pending = await db
    .select({ update: documentUpdates.update })
    .from(documentUpdates)
    .where(eq(documentUpdates.documentId, documentId))
    .orderBy(asc(documentUpdates.seq));

  // Yjs updates are commutative, so replay order does not affect the result --
  // but applying them in sequence order keeps the intermediate states sane if
  // this ever needs stepping through for debugging.
  for (const { update } of pending) Y.applyUpdate(doc, update);

  return doc;
}

/** Append one update. Returns the sequence number the server assigned it. */
export async function appendUpdate(
  db: Executor,
  documentId: string,
  update: Uint8Array,
): Promise<number> {
  const [row] = await db
    .insert(documentUpdates)
    .values({ documentId, update })
    .returning({ seq: documentUpdates.seq });

  return row!.seq;
}

export async function countUpdates(db: Executor, documentId: string): Promise<number> {
  const rows = await db
    .select({ seq: documentUpdates.seq })
    .from(documentUpdates)
    .where(eq(documentUpdates.documentId, documentId));

  return rows.length;
}

/**
 * Merge the update log into the snapshot.
 *
 * Deletes only rows up to the sequence number that was read. An update appended
 * while compaction is in flight has a higher `seq` and survives -- without that
 * bound, a concurrent edit would be merged into nothing and then deleted.
 *
 * The snapshot write and the delete are not wrapped in a transaction, and do
 * not need to be. Ordering makes the crash-safe case the harmless one: if the
 * process dies between them, the log still holds updates already folded into
 * the snapshot, and `loadDocument` reapplies them. Yjs updates are idempotent,
 * so the result is identical -- just a little redundant work until the next
 * compaction.
 */
export async function compactDocument(db: Executor, documentId: string): Promise<void> {
  const pending = await db
    .select({ seq: documentUpdates.seq, update: documentUpdates.update })
    .from(documentUpdates)
    .where(eq(documentUpdates.documentId, documentId))
    .orderBy(asc(documentUpdates.seq));

  if (pending.length === 0) return;

  const highestSeq = pending.at(-1)!.seq;

  const doc = new Y.Doc();

  const [row] = await db
    .select({ snapshot: documents.snapshot })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (row?.snapshot) Y.applyUpdate(doc, row.snapshot);
  for (const { update } of pending) Y.applyUpdate(doc, update);

  const merged = Y.encodeStateAsUpdate(doc);

  await db
    .update(documents)
    .set({ snapshot: merged, updatedAt: new Date() })
    .where(eq(documents.id, documentId));

  await db
    .delete(documentUpdates)
    .where(and(eq(documentUpdates.documentId, documentId), lte(documentUpdates.seq, highestSeq)));
}

/**
 * Append an update, compacting when the log has grown enough.
 *
 * `plainText` is the rendered document, supplied by whoever already has it in
 * memory. Search cannot read the CRDT encoding, and re-deriving the text here
 * would mean rebuilding the whole document on every keystroke batch.
 */
export async function recordUpdate(
  db: Executor,
  documentId: string,
  update: Uint8Array,
  plainText?: string,
): Promise<void> {
  await appendUpdate(db, documentId, update);

  if (plainText !== undefined) {
    await db
      .update(documents)
      .set({ searchText: plainText, updatedAt: new Date() })
      .where(eq(documents.id, documentId));
  }

  if ((await countUpdates(db, documentId)) >= COMPACT_THRESHOLD) {
    await compactDocument(db, documentId);
  }
}

/** Plain-text rendering of the document's shared text, for search and previews. */
export function documentText(doc: Y.Doc): string {
  return doc.getText('content').toString();
}
