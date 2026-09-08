import { createHash } from 'node:crypto';
import { type Database, mutations } from '@relay/database';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.ts';

/**
 * Stripe-style idempotency for offline clients.
 *
 * A queued mutation that is replayed after an ambiguous failure -- request sent,
 * response lost -- must not apply twice. The client attaches a stable
 * `Idempotency-Key` to each queued mutation; the first request to arrive with
 * that key does the work and records its response, and any replay gets the
 * recorded response back instead of re-running the handler.
 *
 * The primary key on `mutations` is the lock. Inserting `pending` is an atomic
 * claim: exactly one concurrent request wins, and the losers either wait for
 * the winner's response or are told to retry.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** How long a replay waits for an in-flight original before giving up. */
const IN_FLIGHT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

function fingerprint(request: FastifyRequest): string {
  return createHash('sha256')
    .update(request.method)
    .update('\n')
    .update(request.url)
    .update('\n')
    .update(JSON.stringify(request.body ?? null))
    .digest('base64url');
}

type Recorded = { responseStatus: number | null; responseBody: string | null; status: string };

async function load(db: Database, key: string): Promise<Recorded | null> {
  const [row] = await db
    .select({
      status: mutations.status,
      responseStatus: mutations.responseStatus,
      responseBody: mutations.responseBody,
    })
    .from(mutations)
    .where(eq(mutations.key, key))
    .limit(1);

  return row ?? null;
}

function replay(reply: FastifyReply, record: Recorded) {
  reply.header('idempotent-replay', 'true');
  return reply
    .status(record.responseStatus ?? 200)
    .send(record.responseBody ? JSON.parse(record.responseBody) : undefined);
}

/**
 * Someone already owns this key. Establish that it is the same caller replaying
 * the same request, then hand back the stored response.
 */
async function replayExistingClaim(
  db: Database,
  reply: FastifyReply,
  claim: { key: string; userId: string; fingerprint: string },
): Promise<unknown> {
  const [existing] = await db
    .select({
      userId: mutations.userId,
      fingerprint: mutations.fingerprint,
      status: mutations.status,
      responseStatus: mutations.responseStatus,
      responseBody: mutations.responseBody,
    })
    .from(mutations)
    .where(eq(mutations.key, claim.key))
    .limit(1);

  // Treat another user's key as unused-but-taken rather than confirming it
  // exists; keys are client-chosen and must not be probeable.
  if (!existing || existing.userId !== claim.userId) {
    throw ApiError.conflict('Idempotency key is already in use', 'idempotency_conflict');
  }

  if (existing.fingerprint !== claim.fingerprint) {
    throw ApiError.conflict(
      'This Idempotency-Key was already used with a different request body',
      'idempotency_mismatch',
    );
  }

  if (existing.status === 'done') return replay(reply, existing);

  // The original is still running. Wait briefly rather than duplicating work.
  const deadline = Date.now() + IN_FLIGHT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const current = await load(db, claim.key);
    if (current?.status === 'done') return replay(reply, current);
  }

  throw ApiError.conflict(
    'A request with this Idempotency-Key is still in progress',
    'idempotency_in_flight',
  );
}

/**
 * Wrap a mutation handler. Without an `Idempotency-Key` header the handler runs
 * normally, so existing clients are unaffected.
 *
 * `handler` returns the body to send; `status` is the success status code.
 */
export async function withIdempotency<T>(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  handler: () => Promise<T>,
): Promise<unknown> {
  const key = request.headers[IDEMPOTENCY_HEADER];

  if (typeof key !== 'string' || key.length === 0) {
    return reply.status(status).send(await handler());
  }

  if (key.length > 200) throw ApiError.badRequest('Idempotency-Key is too long');

  const userId = request.user!.id;
  const print = fingerprint(request);

  // Atomic claim: whoever inserts the row owns the work.
  const [claimed] = await db
    .insert(mutations)
    .values({ key, userId, fingerprint: print, status: 'pending' })
    .onConflictDoNothing({ target: mutations.key })
    .returning({ key: mutations.key });

  if (!claimed) return replayExistingClaim(db, reply, { key, userId, fingerprint: print });

  try {
    const body = await handler();

    await db
      .update(mutations)
      .set({ status: 'done', responseStatus: status, responseBody: JSON.stringify(body ?? null) })
      .where(and(eq(mutations.key, key), eq(mutations.userId, userId)));

    return reply.status(status).send(body);
  } catch (error) {
    // Release the claim so the client can legitimately retry. Keeping a failed
    // attempt would make a transient error permanent for that key.
    await db.delete(mutations).where(and(eq(mutations.key, key), eq(mutations.userId, userId)));
    throw error;
  }
}
