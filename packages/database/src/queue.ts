import { and, eq, lt, lte, or, sql } from 'drizzle-orm';
import type { Database, Executor } from './index.ts';
import { jobs } from './schema.ts';

/**
 * Job queue on Postgres.
 *
 * See the note on the `jobs` table for why this is not Redis. The short
 * version: enqueueing can join the transaction that caused it, so a job is
 * never orphaned by a rollback and never lost by a crash between commit and
 * publish.
 */

/**
 * How long a claimed job may be held before another worker may take it.
 *
 * This is the cost of at-least-once delivery: a worker that hangs past this
 * window has its job reclaimed and run again, so handlers must be idempotent.
 * Too short and slow jobs get duplicated; too long and a crashed worker stalls
 * its jobs for that whole window.
 */
export const VISIBILITY_TIMEOUT_MS = 60_000;

/** Exponential backoff, capped so a permanently broken job still retries daily. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 60 * 60 * 1000);
}

export type EnqueueOptions = {
  /** Delay before the job first becomes eligible. */
  delayMs?: number;
  maxAttempts?: number;
};

/**
 * Schedule a job.
 *
 * Takes an `Executor`, so callers can pass a transaction and have the job
 * commit atomically with whatever caused it.
 */
export async function enqueue(
  db: Executor,
  kind: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<string> {
  const runAt = new Date(Date.now() + (options.delayMs ?? 0));

  const [job] = await db
    .insert(jobs)
    .values({
      kind,
      payload: JSON.stringify(payload ?? {}),
      runAt,
      maxAttempts: options.maxAttempts ?? 5,
    })
    .returning({ id: jobs.id });

  return job!.id;
}

export type ClaimedJob = {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

/**
 * Atomically claim up to `limit` due jobs.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this work with many workers: each
 * transaction locks the rows it selects and *skips* rows already locked by
 * another, so workers take disjoint batches without blocking, and without a
 * coordinator deciding who gets what.
 *
 * The subquery matters. Locking has to happen against the ordered candidate
 * set before the update, otherwise concurrent workers can deadlock by taking
 * the same rows in different orders.
 *
 * Returned oldest-due first. That ordering is applied in JavaScript, because
 * `UPDATE ... RETURNING` makes no promise about row order regardless of what
 * the subquery sorted by.
 */
export async function claimJobs(
  db: Database,
  workerId: string,
  limit = 5,
  now: Date = new Date(),
): Promise<ClaimedJob[]> {
  const staleBefore = new Date(now.getTime() - VISIBILITY_TIMEOUT_MS);

  /*
   * Timestamps are interpolated as ISO strings with an explicit cast. Inside a
   * raw `sql` template there is no column to infer a type from, so the driver
   * would otherwise try to serialise the Date as text and fail at bind time.
   */
  const dueBy = now.toISOString();
  const staleCutoff = staleBefore.toISOString();

  const rows = await db
    .update(jobs)
    .set({ lockedAt: now, lockedBy: workerId, attempts: sql`${jobs.attempts} + 1` })
    .where(
      sql`${jobs.id} in (
        select ${jobs.id} from ${jobs}
        where ${jobs.status} = 'pending'
          and ${jobs.runAt} <= ${dueBy}::timestamptz
          and (${jobs.lockedAt} is null or ${jobs.lockedAt} < ${staleCutoff}::timestamptz)
        order by ${jobs.runAt}
        for update skip locked
        limit ${limit}
      )`,
    )
    .returning({
      id: jobs.id,
      kind: jobs.kind,
      payload: jobs.payload,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      runAt: jobs.runAt,
    });

  /*
   * The `order by` in the subquery decides *which* rows are claimed, not the
   * order `RETURNING` emits them in -- Postgres leaves that unspecified. Sort
   * here so the runner genuinely processes a batch oldest-first rather than
   * relying on an ordering the database never promised.
   */
  return rows
    .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
    .map(({ runAt: _runAt, ...row }) => ({ ...row, payload: JSON.parse(row.payload) }));
}

/**
 * Mark a job done.
 *
 * Successful jobs are deleted rather than kept. The queue table is hot and
 * should stay small; `audit_events` already records what actually happened,
 * and a completed-job archive nobody reads is just vacuum pressure.
 */
export async function completeJob(db: Executor, jobId: string): Promise<void> {
  await db.delete(jobs).where(eq(jobs.id, jobId));
}

/**
 * Record a failure: reschedule with backoff, or dead-letter once the attempt
 * budget is spent.
 *
 * Failed jobs are kept, unlike successful ones -- they are the ones worth
 * looking at.
 */
export async function failJob(
  db: Executor,
  job: ClaimedJob,
  error: unknown,
  now: Date = new Date(),
): Promise<'retrying' | 'dead'> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  await db
    .update(jobs)
    .set({
      status: exhausted ? 'failed' : 'pending',
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      runAt: exhausted ? undefined : new Date(now.getTime() + backoffMs(job.attempts)),
    })
    .where(eq(jobs.id, job.id));

  return exhausted ? 'dead' : 'retrying';
}

/** Jobs that are due and unclaimed. Used by tests and health reporting. */
export async function pendingCount(db: Executor, now: Date = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - VISIBILITY_TIMEOUT_MS);

  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'pending'),
        lte(jobs.runAt, now),
        or(sql`${jobs.lockedAt} is null`, lt(jobs.lockedAt, staleBefore)),
      ),
    );

  return rows.length;
}

export async function deadLetterCount(db: Executor): Promise<number> {
  const rows = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'failed'));
  return rows.length;
}
