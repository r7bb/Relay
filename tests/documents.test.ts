import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  COMPACT_THRESHOLD,
  compactDocument,
  documents,
  documentText,
  loadDocument,
  recordUpdate,
} from '@relay/database';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  type Actor,
  closeHarness,
  createActor,
  createWorkspace,
  getHarness,
  resetDatabase,
} from './harness.ts';

/**
 * CRDT documents.
 *
 * The convergence tests are the point of the whole milestone. Everything else
 * in Relay merges under last-write-wins, which is fine for a status field and
 * catastrophic for a paragraph: two people typing in the same sentence would
 * lose one of the edits. These assert that they do not.
 */

beforeEach(resetDatabase);
afterAll(closeHarness);

async function createDocument(actor: Actor, workspaceId: string, title = 'Architecture') {
  const { db } = await getHarness();

  const [document] = await db
    .insert(documents)
    .values({ workspaceId, title, createdBy: actor.id })
    .returning();

  return document!;
}

/** A client holding its own replica of the document. */
class Replica {
  readonly doc = new Y.Doc();

  get text() {
    return this.doc.getText('content');
  }

  type(index: number, content: string) {
    this.text.insert(index, content);
  }

  delete(index: number, length: number) {
    this.text.delete(index, length);
  }

  toString() {
    return this.text.toString();
  }

  /** Everything this replica knows that `other` does not. */
  diffFor(other: Replica): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(other.doc));
  }

  apply(update: Uint8Array) {
    Y.applyUpdate(this.doc, update);
  }
}

describe('convergence', () => {
  /**
   * The scenario from the brief: Alice and Bob edit the same paragraph while
   * both are offline. Neither edit may be lost, and both must end up identical.
   */
  test('concurrent edits to the same paragraph both survive', async () => {
    const alice = new Replica();
    const bob = new Replica();

    // Start from a shared base.
    alice.type(0, 'The authentication service will use OAuth.');
    bob.apply(alice.diffFor(bob));
    expect(bob.toString()).toBe('The authentication service will use OAuth.');

    // Both go offline and edit the same sentence.
    alice.type(alice.toString().length - 1, ' with PKCE');
    bob.type(0, 'Draft: ');

    // Still divergent while disconnected.
    expect(alice.toString()).not.toBe(bob.toString());

    // Reconnect: exchange what each is missing.
    const fromAlice = alice.diffFor(bob);
    const fromBob = bob.diffFor(alice);
    alice.apply(fromBob);
    bob.apply(fromAlice);

    expect(alice.toString()).toBe(bob.toString());
    expect(alice.toString()).toContain('with PKCE');
    expect(alice.toString()).toContain('Draft: ');
  });

  /**
   * Commutativity is the property that makes a lossy transport survivable: a
   * client that receives updates out of order must still land in the same
   * state as one that received them in order.
   */
  test('applying updates in different orders produces identical documents', async () => {
    const origin = new Replica();
    origin.type(0, 'base');

    const a = new Replica();
    const b = new Replica();
    const c = new Replica();
    for (const replica of [a, b, c]) replica.apply(Y.encodeStateAsUpdate(origin.doc));

    a.type(4, ' from A');
    b.type(0, 'B: ');
    c.type(2, 'XX');

    const updates = [a, b, c].map((replica) => Y.encodeStateAsUpdate(replica.doc));

    const forward = new Replica();
    for (const update of updates) forward.apply(update);

    const backward = new Replica();
    for (const update of [...updates].reverse()) backward.apply(update);

    const shuffled = new Replica();
    for (const update of [updates[1]!, updates[2]!, updates[0]!]) shuffled.apply(update);

    expect(forward.toString()).toBe(backward.toString());
    expect(forward.toString()).toBe(shuffled.toString());
  });

  test('applying the same update twice is a no-op', async () => {
    const alice = new Replica();
    const bob = new Replica();

    alice.type(0, 'exactly once');
    const update = Y.encodeStateAsUpdate(alice.doc);

    bob.apply(update);
    bob.apply(update);
    bob.apply(update);

    expect(bob.toString()).toBe('exactly once');
  });

  test('concurrent deletes and inserts do not corrupt the text', async () => {
    const alice = new Replica();
    const bob = new Replica();

    alice.type(0, 'the quick brown fox');
    bob.apply(alice.diffFor(bob));

    // Alice deletes a word while Bob appends.
    alice.delete(4, 6); // "quick "
    bob.type(19, ' jumps');

    const fromAlice = alice.diffFor(bob);
    const fromBob = bob.diffFor(alice);
    alice.apply(fromBob);
    bob.apply(fromAlice);

    expect(alice.toString()).toBe(bob.toString());
    expect(alice.toString()).toBe('the brown fox jumps');
  });

  /** Many replicas, many edits, arbitrary pairwise sync order. */
  test('five replicas converge after interleaved offline editing', async () => {
    const replicas = Array.from({ length: 5 }, () => new Replica());

    replicas[0]!.type(0, 'shared');
    const base = Y.encodeStateAsUpdate(replicas[0]!.doc);
    for (const replica of replicas.slice(1)) replica.apply(base);

    replicas.forEach((replica, index) => {
      replica.type(0, `${index}:`);
      replica.type(replica.toString().length, `-end${index}`);
    });

    // Gossip every pair in both directions, twice, in no particular order.
    for (let round = 0; round < 2; round++) {
      for (const a of replicas) {
        for (const b of replicas) {
          if (a === b) continue;
          b.apply(a.diffFor(b));
        }
      }
    }

    const texts = replicas.map((replica) => replica.toString());
    expect(new Set(texts).size).toBe(1);

    // And nothing was lost.
    for (let index = 0; index < replicas.length; index++) {
      expect(texts[0]).toContain(`${index}:`);
      expect(texts[0]).toContain(`-end${index}`);
    }
  });
});

describe('persistence', () => {
  test('a document round-trips through the database', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Author');
    const workspace = await createWorkspace(actor);
    const document = await createDocument(actor, workspace.id);

    const local = new Replica();
    local.type(0, 'Persisted content');
    await recordUpdate(db, document.id, Y.encodeStateAsUpdate(local.doc));

    const loaded = await loadDocument(db, document.id);
    expect(documentText(loaded)).toBe('Persisted content');
  });

  test('updates accumulate across separate writes', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Author');
    const workspace = await createWorkspace(actor);
    const document = await createDocument(actor, workspace.id);

    const local = new Replica();

    for (const word of ['one ', 'two ', 'three']) {
      const before = Y.encodeStateVector(local.doc);
      local.type(local.toString().length, word);
      await recordUpdate(db, document.id, Y.encodeStateAsUpdate(local.doc, before));
    }

    const loaded = await loadDocument(db, document.id);
    expect(documentText(loaded)).toBe('one two three');
  });

  test('compaction folds the log into the snapshot without changing the text', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Author');
    const workspace = await createWorkspace(actor);
    const document = await createDocument(actor, workspace.id);

    const local = new Replica();

    for (let i = 0; i < 10; i++) {
      const before = Y.encodeStateVector(local.doc);
      local.type(local.toString().length, `${i}`);
      await recordUpdate(db, document.id, Y.encodeStateAsUpdate(local.doc, before));
    }

    const beforeCompaction = documentText(await loadDocument(db, document.id));
    expect(beforeCompaction).toBe('0123456789');

    await compactDocument(db, document.id);

    // The log is gone and the snapshot carries the state.
    const [row] = await db
      .select({ snapshot: documents.snapshot })
      .from(documents)
      .where(eq(documents.id, document.id));
    expect(row?.snapshot).toBeTruthy();

    expect(documentText(await loadDocument(db, document.id))).toBe('0123456789');
  });

  test('compaction happens automatically past the threshold', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Author');
    const workspace = await createWorkspace(actor);
    const document = await createDocument(actor, workspace.id);

    const local = new Replica();

    for (let i = 0; i < COMPACT_THRESHOLD + 5; i++) {
      const before = Y.encodeStateVector(local.doc);
      local.type(local.toString().length, 'x');
      await recordUpdate(db, document.id, Y.encodeStateAsUpdate(local.doc, before));
    }

    const [row] = await db
      .select({ snapshot: documents.snapshot })
      .from(documents)
      .where(eq(documents.id, document.id));

    expect(row?.snapshot).toBeTruthy();
    expect(documentText(await loadDocument(db, document.id))).toHaveLength(COMPACT_THRESHOLD + 5);
  });

  /**
   * A client that was offline while others edited must be able to catch up and
   * still contribute what it wrote.
   */
  test('a stale replica reconciles with the persisted document', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Author');
    const workspace = await createWorkspace(actor);
    const document = await createDocument(actor, workspace.id);

    const online = new Replica();
    online.type(0, 'Written while you were away. ');
    await recordUpdate(db, document.id, Y.encodeStateAsUpdate(online.doc));

    // Offline client, started from an empty document, wrote its own paragraph.
    const offline = new Replica();
    offline.type(0, 'My offline paragraph.');

    // It reconnects: pulls server state, pushes its own.
    const server = await loadDocument(db, document.id);
    Y.applyUpdate(offline.doc, Y.encodeStateAsUpdate(server));
    await recordUpdate(db, document.id, Y.encodeStateAsUpdate(offline.doc));

    const final = documentText(await loadDocument(db, document.id));
    expect(final).toContain('Written while you were away.');
    expect(final).toContain('My offline paragraph.');
    expect(final).toBe(offline.toString());
  });

  test('documents are removed with their workspace', async () => {
    const { db } = await getHarness();
    const actor = await createActor('Author');
    const workspace = await createWorkspace(actor);
    const document = await createDocument(actor, workspace.id);

    await recordUpdate(db, document.id, Y.encodeStateAsUpdate(new Y.Doc()));

    await db.execute(`DELETE FROM workspaces WHERE id = '${workspace.id}'`);

    const remaining = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, document.id));

    expect(remaining).toHaveLength(0);
  });
});
