import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ApiError } from '../errors.ts';

/**
 * Fixed-window rate limiting, in process memory.
 *
 * Deliberately not Redis. A single API instance is the deployment this repo
 * describes, and an in-memory counter needs no extra service; behind several
 * instances each enforces its own share, which for a login throttle means the
 * effective limit is `limit × instances` -- looser than intended, but still
 * bounded, and the failure mode is permissive rather than locking people out.
 * A shared store is the fix when that matters.
 *
 * A fixed window rather than a sliding one, for the same reason: it is a
 * counter and a timestamp. The known weakness is a burst spanning a window
 * boundary landing up to 2× the limit, which is acceptable for throttling
 * credential stuffing and not acceptable for billing.
 */

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Distinguishes one limiter's buckets from another's. */
  name: string;
};

/**
 * Buckets live for one window, so the map is swept rather than grown forever.
 * Without this an attacker rotating IPs is a memory leak.
 */
const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Exported for tests, which need a clean slate between cases. */
export function resetRateLimits() {
  buckets.clear();
  lastSweep = Date.now();
}

/**
 * Identify the caller.
 *
 * A signed-in user is limited per account, so sharing an office IP does not
 * mean sharing a quota. Anonymous traffic -- which is exactly where login
 * abuse lives -- falls back to the address.
 */
function identify(request: FastifyRequest): string {
  return request.user?.id ?? request.ip;
}

export function rateLimit(options: RateLimitOptions): preHandlerHookHandler {
  const { limit, windowMs, name } = options;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    sweep(now);

    const key = `${name}:${identify(request)}`;
    const existing = buckets.get(key);

    const bucket =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };

    bucket.count++;
    buckets.set(key, bucket);

    const remaining = Math.max(0, limit - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    reply.header('ratelimit-limit', String(limit));
    reply.header('ratelimit-remaining', String(remaining));
    reply.header('ratelimit-reset', String(resetSeconds));

    if (bucket.count > limit) {
      // `Retry-After` tells a well-behaved client when to come back, and the
      // sync engine treats 429 as transient rather than dropping the mutation.
      reply.header('retry-after', String(resetSeconds));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.');
    }
  };
}
