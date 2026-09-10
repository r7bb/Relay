/**
 * Latency statistics for the load harness.
 *
 * This lives in a package rather than next to the script because a benchmark
 * whose arithmetic is wrong is worse than no benchmark -- it produces confident
 * numbers nobody checks. Percentiles in particular have several defensible
 * definitions that disagree on small samples, so the one used here is written
 * down and tested rather than left to a one-line reduction in a script.
 */

export type Summary = {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
};

/**
 * Nearest-rank percentile: the smallest value at or below which at least `p`
 * percent of the samples fall.
 *
 * Deliberately not interpolating between neighbours. An interpolated p99 is a
 * number that never happened -- for latency it is more useful to be able to say
 * "one real request took this long" than to report a weighted average of two
 * requests either side of the boundary. On a large sample the two agree to
 * within noise anyway; on a small one, nearest-rank is the honest answer.
 *
 * Expects samples in ascending order. `sortedSamples` must not be empty.
 */
export function percentileOfSorted(sortedSamples: readonly number[], p: number): number {
  if (sortedSamples.length === 0) {
    throw new Error('percentile of an empty sample is undefined');
  }

  // ceil(p/100 * n) is the rank; clamping handles p = 0 and floating-point
  // drift at p = 100, both of which would otherwise index out of bounds.
  const rank = Math.ceil((p / 100) * sortedSamples.length);
  const index = Math.min(sortedSamples.length - 1, Math.max(0, rank - 1));

  return sortedSamples[index]!;
}

/** Convenience wrapper that sorts a copy. Prefer `summarize` for several percentiles. */
export function percentile(samples: readonly number[], p: number): number {
  return percentileOfSorted(
    [...samples].sort((a, b) => a - b),
    p,
  );
}

/** Returns null for an empty sample rather than inventing zeroes. */
export function summarize(samples: readonly number[]): Summary | null {
  if (samples.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: total / sorted.length,
    p50: percentileOfSorted(sorted, 50),
    p95: percentileOfSorted(sorted, 95),
    p99: percentileOfSorted(sorted, 99),
  };
}

/** Fixed width so successive rows line up in a terminal table. */
export function formatMs(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
