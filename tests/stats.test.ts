import { describe, expect, test } from 'bun:test';
import { formatMs, percentile, summarize } from '@relay/shared';

/**
 * Statistics for the load harness.
 *
 * Benchmarks are believed uncritically, so the arithmetic behind the numbers
 * in the README is tested like anything else. The cases that matter are the
 * small and degenerate samples, where percentile definitions disagree.
 */

describe('percentile', () => {
  /** 1..100 makes the expected rank readable by inspection. */
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  test('nearest-rank picks a value that is actually in the sample', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
  });

  test('the extremes are the extremes', () => {
    expect(percentile(hundred, 0)).toBe(1);
    expect(percentile(hundred, 100)).toBe(100);
  });

  test('a single sample is every percentile of itself', () => {
    for (const p of [0, 50, 95, 99, 100]) {
      expect(percentile([7], p)).toBe(7);
    }
  });

  test('input order does not matter', () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
    expect(percentile([1, 3, 5, 7, 9], 50)).toBe(5);
  });

  test('the input is not mutated', () => {
    const samples = [3, 1, 2];
    percentile(samples, 50);
    expect(samples).toEqual([3, 1, 2]);
  });

  /**
   * The reason this is not interpolated: with nine samples there is no
   * "99th" one, and reporting 8.9 would name a latency no request had.
   */
  test('a percentile above every rank boundary lands on the top sample', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9], 99)).toBe(9);
  });

  test('an empty sample throws rather than returning zero', () => {
    expect(() => percentile([], 50)).toThrow();
  });
});

describe('summarize', () => {
  test('reports the shape of the distribution', () => {
    const result = summarize([10, 20, 30, 40])!;

    expect(result.count).toBe(4);
    expect(result.min).toBe(10);
    expect(result.max).toBe(40);
    expect(result.mean).toBe(25);
  });

  /** An empty run should read as "no data", not as "zero milliseconds". */
  test('an empty sample summarizes to null', () => {
    expect(summarize([])).toBeNull();
  });

  test('a long tail moves the mean but not the median', () => {
    const samples = [...Array.from({ length: 99 }, () => 1), 1000];
    const result = summarize(samples)!;

    expect(result.p50).toBe(1);
    expect(result.max).toBe(1000);
    expect(result.mean).toBeGreaterThan(10);
  });
});

describe('formatMs', () => {
  test('keeps precision where it is informative and drops it where it is not', () => {
    expect(formatMs(1.234)).toBe('1.23');
    expect(formatMs(12.34)).toBe('12.3');
    expect(formatMs(1234)).toBe('1234');
  });
});
