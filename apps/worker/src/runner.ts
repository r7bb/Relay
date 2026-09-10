import { type ClaimedJob, claimJobs, completeJob, type Database, failJob } from '@relay/database';

/**
 * The worker loop.
 *
 * Polls for due jobs, runs them, and records the outcome. Kept separate from
 * `main.ts` so tests can drive it a tick at a time instead of racing a timer.
 */

export type JobHandler = (payload: unknown, context: { db: Database }) => Promise<void>;
export type Handlers = Record<string, JobHandler>;

export type RunnerOptions = {
  db: Database;
  handlers: Handlers;
  workerId?: string;
  /** Jobs claimed per tick. */
  batchSize?: number;
  /** Gap between polls when the queue is empty. */
  idleDelayMs?: number;
};

export type TickResult = { claimed: number; completed: number; failed: number; dead: number };

export class Runner {
  private readonly db: Database;
  private readonly handlers: Handlers;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly idleDelayMs: number;

  private running = false;

  constructor(options: RunnerOptions) {
    this.db = options.db;
    this.handlers = options.handlers;
    this.workerId = options.workerId ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
    this.batchSize = options.batchSize ?? 5;
    this.idleDelayMs = options.idleDelayMs ?? 1000;
  }

  get id(): string {
    return this.workerId;
  }

  /** Claim and process one batch. Returns what happened, for tests and metrics. */
  async tick(): Promise<TickResult> {
    const result: TickResult = { claimed: 0, completed: 0, failed: 0, dead: 0 };

    const batch = await claimJobs(this.db, this.workerId, this.batchSize);
    result.claimed = batch.length;

    // Sequential rather than parallel: these are database-bound, and running a
    // batch concurrently would multiply this worker's connection use for no
    // throughput gain that adding a second worker would not give more simply.
    for (const job of batch) {
      const outcome = await this.run(job);
      if (outcome === 'completed') result.completed++;
      else if (outcome === 'dead') result.dead++;
      else result.failed++;
    }

    return result;
  }

  private async run(job: ClaimedJob): Promise<'completed' | 'retrying' | 'dead'> {
    const handler = this.handlers[job.kind];

    if (!handler) {
      // An unknown kind is a deploy-ordering problem, not a transient fault.
      // Retrying would spin until the attempt budget runs out, so fail it to
      // the dead-letter state immediately.
      await failJob(this.db, { ...job, attempts: job.maxAttempts }, `No handler for "${job.kind}"`);
      return 'dead';
    }

    try {
      await handler(job.payload, { db: this.db });
      await completeJob(this.db, job.id);
      return 'completed';
    } catch (error) {
      return failJob(this.db, job, error);
    }
  }

  /** Poll until `stop()`. */
  async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      let worked = 0;

      try {
        worked = (await this.tick()).claimed;
      } catch (error) {
        // A failure here is the queue itself being unreachable, not a job
        // failing. Back off rather than spinning against a dead database.
        console.error('worker: tick failed', error);
        await Bun.sleep(this.idleDelayMs);
      }

      // Only pause when there was nothing to do; a full batch probably means
      // more is waiting.
      if (worked === 0) await Bun.sleep(this.idleDelayMs);
    }
  }

  stop(): void {
    this.running = false;
  }
}
